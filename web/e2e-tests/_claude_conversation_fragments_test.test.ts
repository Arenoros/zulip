import {execSync} from "node:child_process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "conversation-fragments";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Messages sent in order of time: a topic two days ago, interrupted
// by a direct message; a topic that runs past midnight into today;
// a group direct message, a note to self, a topic with a long name
// and a long topic today. Desdemona has read everything; one message
// mentions her, one is starred and one of hers has a reaction.
const seed_script = String.raw`import json
from datetime import timedelta

from django.db.models import F
from django.utils.timezone import now as timezone_now

from zerver.actions.message_flags import do_update_message_flags
from zerver.actions.message_send import (
    internal_send_group_direct_message,
    internal_send_private_message,
    internal_send_stream_message,
)
from zerver.actions.reactions import do_add_reaction
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.models import Message, UserMessage
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)

stream, _ = create_stream_if_needed(realm, "fragments", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, iago, hamlet, othello], acting_user=None)
today = timezone_now().replace(hour=9, minute=0, second=0, microsecond=0)
two_days_ago = today - timedelta(days=2)
midnight = today.replace(hour=0)


def dated(message_id, date_sent):
    Message.objects.filter(id=message_id).update(date_sent=date_sent)
    return message_id


def send(sender, topic, content, date_sent):
    return dated(internal_send_stream_message(sender, stream, topic, content), date_sent)


ids = {}
ids["plans"] = [
    send(hamlet, "plans", "Shall we plan the trip?", two_days_ago),
    send(hamlet, "plans", "Next month?", two_days_ago + timedelta(minutes=1)),
]
ids["dm"] = dated(
    internal_send_private_message(othello, desdemona, "Did you see the plans?"),
    two_days_ago + timedelta(minutes=2),
)
ids["plans"].append(
    send(iago, "plans", "@**Desdemona** next month works.", two_days_ago + timedelta(minutes=3))
)
ids["night"] = [
    send(iago, "night", "Still up?", midnight - timedelta(minutes=1)),
    send(othello, "night", "Yes.", midnight + timedelta(minutes=1)),
]
ids["group"] = dated(
    internal_send_group_direct_message(
        realm, othello, "Lunch?", recipient_users=[desdemona, hamlet]
    ),
    today,
)
ids["self"] = dated(
    internal_send_private_message(desdemona, desdemona, "Buy milk."),
    today + timedelta(minutes=1),
)
long_topic = "A very long topic name that keeps going and going so that it cannot fit next to the link"
ids["long_topic"] = send(iago, long_topic, "A long topic.", today + timedelta(minutes=2))
ids["long"] = [
    send(iago if i % 2 else othello, "long", f"Long fragment message {i}.", today + timedelta(minutes=10 + i))
    for i in range(30)
]

UserMessage.objects.filter(user_profile=desdemona).update(
    flags=F("flags").bitor(UserMessage.flags.read)
)
do_update_message_flags(desdemona, "add", "starred", [ids["plans"][0]])
do_add_reaction(iago, Message.objects.get(id=ids["self"]), "smile", "1f604", "unicode_emoji")

print(
    "SEEDED "
    + json.dumps(
        {
            "ids": ids,
            "stream_id": stream.id,
            "othello_id": othello.id,
            "hamlet_id": hamlet.id,
            "iago_id": iago.id,
            "long_topic": long_topic,
        }
    )
)
`;

type Seeded = {
    ids: {
        plans: number[];
        dm: number;
        night: number[];
        group: number;
        self: number;
        long_topic: number;
        long: number[];
    };
    stream_id: number;
    othello_id: number;
    hamlet_id: number;
    iago_id: number;
    long_topic: string;
};

async function api(page: Page, method: string, url: string, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(
        async (method, url, body) => {
            const csrf_token =
                document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                    ?.value ?? "";
            const response = await fetch(url, {
                method,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": csrf_token,
                },
                body,
            });
            return response.status;
        },
        method,
        url,
        body,
    );
    if (status !== 200) {
        throw new Error(`${method} ${url} ${body}: ${status}`);
    }
}

function row(id: number): string {
    return `.focused-message-list .message_row[data-message-id="${id}"]`;
}

function group_of(id: number): string {
    return `.focused-message-list .recipient_row:has(.message_row[data-message-id="${id}"])`;
}

async function open(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

type Header = {
    fragment: boolean;
    label: string;
    topic: string;
    open_text: string;
    open_href: string;
    icon: string;
    date_shown: boolean;
    divider: string | undefined;
};

async function header_of(page: Page, message_id: number): Promise<Header> {
    return await page.$eval(row(message_id), (row) => {
        const group = row.closest(".recipient_row")!;
        const header = group.querySelector(".message_header")!;
        const open = header.querySelector<HTMLAnchorElement>(".conversation-fragment-open");
        const date = header.querySelector(".recipient_row_date");
        const icon = header.querySelector(".stream_label .zulip-icon");
        return {
            fragment: header.classList.contains("conversation-fragment-header"),
            label: header
                .querySelector(".stream_label")!
                .textContent.replaceAll(/\s+/g, " ")
                .trim(),
            topic: header.querySelector(".stream_topic")?.textContent.trim() ?? "",
            open_text: open?.textContent.trim() ?? "",
            open_href: open?.getAttribute("href") ?? "",
            icon: [...(icon?.classList ?? [])].find((name) => name !== "zulip-icon") ?? "",
            date_shown: date !== null && getComputedStyle(date).display !== "none",
            divider: group
                .querySelector(":scope > .conversation-fragment-date-divider")
                ?.textContent.trim(),
        };
    });
}

async function is_mixed_view(page: Page): Promise<{mixed: boolean; fragments: number}> {
    return await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!;
        return {
            mixed: list.classList.contains("mixed-view"),
            fragments: list.querySelectorAll(".conversation-fragment-header").length,
        };
    });
}

async function conversation_fragments_test(page: Page): Promise<void> {
    const output = run_python(seed_script);
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    const {ids, stream_id, othello_id, hamlet_id, iago_id} = seeded;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await api(
        page,
        "PATCH",
        "/json/settings",
        "web_channel_default_view=5&color_scheme=3&web_font_size_px=15&timezone=UTC",
    );

    await open(page, "#feed");
    await page.waitForSelector(row(ids.long.at(-1)!), {visible: true});
    const list = await is_mixed_view(page);
    check(
        "the combined feed is a mixed view, with a fragment header on every group",
        list.mixed &&
            list.fragments ===
                (await page.$$eval(".focused-message-list .message_header", (h) => h.length)),
        JSON.stringify(list),
    );

    // Headers.
    await page.$eval(row(ids.plans[0]!), (row) => {
        row.scrollIntoView({block: "center"});
    });
    const plans = await header_of(page, ids.plans[0]!);
    check(
        "a channel fragment names the channel and topic, and links to the conversation",
        plans.fragment &&
            plans.label === "fragments" &&
            plans.topic === "plans" &&
            plans.open_text === "Open conversation" &&
            plans.open_href.includes(`/channel/${stream_id}-fragments/topic/plans`) &&
            !plans.date_shown,
        JSON.stringify(plans),
    );
    const dm = await header_of(page, ids.dm);
    check(
        "a direct message fragment names the other person",
        dm.label === "Direct messages > Othello, the Moor of Venice" &&
            dm.icon === "zulip-icon-message-square" &&
            dm.open_text === "Open chat" &&
            dm.open_href.includes(`/dm/${othello_id}-`) &&
            !dm.date_shown,
        JSON.stringify(dm),
    );
    const group = await header_of(page, ids.group);
    check(
        "a group direct message fragment names the other people",
        group.label === "Group chat > King Hamlet, Othello, the Moor of Venice" &&
            group.icon === "zulip-icon-users" &&
            group.open_text === "Open chat",
        JSON.stringify(group),
    );
    const self = await header_of(page, ids.self);
    check(
        "a note to self is a direct message fragment",
        self.label === "Direct messages > Messages with yourself" && self.open_text === "Open chat",
        JSON.stringify(self),
    );

    // Dates.
    const plans_again = await header_of(page, ids.plans[2]!);
    const night = await header_of(page, ids.night[0]!);
    const night_inside = await page.$eval(row(ids.night[1]!), (row) => {
        const divider = row.querySelector(".message_feed_divider");
        const text = divider?.querySelector(".date-divider-content");
        if (!divider || !text) {
            return undefined;
        }
        const divider_box = divider.getBoundingClientRect();
        const text_box = text.getBoundingClientRect();
        return {
            text: text.textContent.trim(),
            off_center: Math.round(
                text_box.left + text_box.width / 2 - (divider_box.left + divider_box.width / 2),
            ),
        };
    });
    check(
        "the date is a divider above a fragment from another day than the message before",
        dm.divider === undefined &&
            plans_again.divider === undefined &&
            night.divider === "Yesterday" &&
            group.divider === undefined,
        JSON.stringify([dm.divider, plans_again.divider, night.divider, group.divider]),
    );
    check(
        "a fragment that runs past midnight has a centered date divider inside",
        night_inside?.text === "Today" && Math.abs(night_inside.off_center) <= 2,
        JSON.stringify(night_inside),
    );

    // Card colors.
    const colors = await page.$eval(row(ids.plans[0]!), (row) => {
        const header = row
            .closest(".recipient_row")!
            .querySelector<HTMLElement>(".message-header-contents")!;
        const icon = row
            .closest(".recipient_row")!
            .querySelector<HTMLElement>(".conversation-fragment-channel-icon")!;
        return {
            header: getComputedStyle(header).backgroundColor,
            row: getComputedStyle(row).backgroundColor,
            feed: getComputedStyle(document.body).backgroundColor,
            icon: getComputedStyle(icon).backgroundColor,
            radius: getComputedStyle(header).borderTopLeftRadius,
        };
    });
    const channel_color = await page.evaluate(
        (name) => zulip_test.get_sub(name)!.color,
        "fragments",
    );
    check(
        "a fragment is a card: its header has the color of its messages, the channel color is in its icon",
        colors.header === colors.row &&
            colors.header !== colors.feed &&
            colors.radius === "8px" &&
            colors.icon !== "rgba(0, 0, 0, 0)",
        JSON.stringify({...colors, channel_color}),
    );
    await shot(page, "light");

    // Topic actions show on hover.
    const controls_opacity = async (): Promise<string> =>
        await page.$eval(
            row(ids.plans[2]!),
            (row) =>
                getComputedStyle(
                    row.closest(".recipient_row")!.querySelector(".recipient_bar_controls")!,
                ).opacity,
        );
    await page.$eval(row(ids.plans[2]!), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const hidden_opacity = await controls_opacity();
    const header_box = await page.$eval(row(ids.plans[2]!), (row) => {
        const box = row
            .closest(".recipient_row")!
            .querySelector(".message-header-contents")!
            .getBoundingClientRect();
        return {x: box.left + box.width / 2, y: box.top + box.height / 2};
    });
    await page.mouse.move(header_box.x, header_box.y);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const shown_opacity = await controls_opacity();
    const order = await page.$eval(row(ids.plans[2]!), (row) => {
        const header = row.closest(".recipient_row")!;
        const controls = header.querySelector(".recipient_bar_controls")!.getBoundingClientRect();
        const link = header.querySelector(".conversation-fragment-open")!.getBoundingClientRect();
        return {controls_right: Math.round(controls.right), link_left: Math.round(link.left)};
    });
    check(
        "the topic actions show on hover, next to the link",
        hidden_opacity === "0" &&
            shown_opacity === "1" &&
            order.link_left - order.controls_right >= 0 &&
            order.link_left - order.controls_right <= 4,
        JSON.stringify({hidden_opacity, shown_opacity, ...order}),
    );
    await shot(page, "hover");

    // Topic editing in the header.
    await page.click(
        `${group_of(ids.plans[2]!)} .on_hover_topic_edit`,
    );
    const editing = await page
        .waitForSelector(".focused-message-list .conversation-fragment-header .topic_edit_form", {
            visible: true,
            timeout: 5000,
        })
        .then(() => true)
        .catch(() => false);
    await page.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 500));
    check("the topic can be edited in the fragment header", editing);

    // Sticky header.
    await page.$eval(row(ids.long[15]!), (row) => {
        row.scrollIntoView({block: "start"});
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const sticky = await page.$eval(row(ids.long[0]!), (row) => {
        const header = row.closest(".recipient_row")!.querySelector(".message-header-contents")!;
        const navbar = document.querySelector("#navbar-fixed-container")!;
        return {
            header_top: Math.round(header.getBoundingClientRect().top),
            navbar_bottom: Math.round(navbar.getBoundingClientRect().bottom),
            first_row_top: Math.round(row.getBoundingClientRect().top),
        };
    });
    check(
        "the header of a long fragment sticks below the navbar",
        sticky.first_row_top < sticky.navbar_bottom &&
            sticky.header_top >= sticky.navbar_bottom &&
            sticky.header_top - sticky.navbar_bottom <= 12,
        JSON.stringify(sticky),
    );

    // Scroll to date from a divider between cards.
    await page.$eval(row(ids.night[0]!), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await page.click(
        `${group_of(ids.night[0]!)} > .conversation-fragment-date-divider .scroll-to-time`,
    );
    const scroll_popover = await page
        .waitForSelector("#scroll-to-time-popover", {
            visible: true,
            timeout: 5000,
        })
        .then(() => true)
        .catch(() => false);
    check("the date divider between cards opens Scroll to date", scroll_popover);
    await page.keyboard.press("Escape");

    // Links.
    await page.$eval(row(ids.plans[0]!), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await page.click(
        `${group_of(ids.plans[0]!)} .conversation-fragment-open`,
    );
    const opened_topic = await page
        .waitForSelector(".focused-message-list.open-conversation .message_row", {
            visible: true,
            timeout: 10000,
        })
        .then(() => true)
        .catch(() => false);
    check(
        "Open conversation opens the topic",
        opened_topic && page.url().includes("/topic/plans"),
        page.url(),
    );
    await open(page, "#feed");
    await page.waitForSelector(row(ids.dm), {visible: true});
    await page.$eval(row(ids.dm), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await page.click(
        `${group_of(ids.dm)} .conversation-fragment-open`,
    );
    await page.waitForFunction(() => window.location.hash.includes("/dm/"), {timeout: 10000});
    await page.waitForSelector(".focused-message-list:not(.mixed-view) .message_row", {
        visible: true,
    });
    check("Open chat opens the direct message conversation", true, page.url());

    // Other mixed views.
    const mixed_views: [string, string][] = [
        ["mentions", "#narrow/is/mentioned"],
        ["starred messages", "#narrow/is/starred"],
        ["reactions", "#narrow/has/reaction/sender/me"],
        ["all direct messages", "#narrow/is/dm"],
        ["messages from a sender", `#narrow/sender/${iago_id}`],
        ["a search in one direct message conversation", `#narrow/dm/${othello_id}/sender/${othello_id}`],
    ];
    const not_mixed: string[] = [];
    for (const [name, hash] of mixed_views) {
        await open(page, hash);
        const state = await is_mixed_view(page);
        if (!state.mixed || state.fragments === 0) {
            not_mixed.push(`${name}: ${JSON.stringify(state)}`);
        }
    }
    await api(page, "PATCH", "/json/settings", "web_channel_default_view=2");
    await open(page, `#narrow/channel/${stream_id}-fragments`);
    const channel_feed = await is_mixed_view(page);
    if (!channel_feed.mixed || channel_feed.fragments === 0) {
        not_mixed.push(`channel feed: ${JSON.stringify(channel_feed)}`);
    }
    check(
        "mentions, starred, reactions, direct messages, a sender, a search in a conversation and the channel feed are mixed views",
        not_mixed.length === 0,
        not_mixed.join("; "),
    );

    // Views of one conversation keep their layout.
    await open(page, `#narrow/channel/${stream_id}-fragments/topic/plans`);
    const classic_topic = await is_mixed_view(page);
    await api(page, "PATCH", "/json/settings", "web_channel_default_view=5");
    await open(page, `#narrow/channel/${stream_id}-fragments/topic/plans`);
    await page.waitForSelector(".focused-message-list.open-conversation");
    const open_conversation = await is_mixed_view(page);
    await open(page, `#narrow/dm/${othello_id}`);
    const direct = await is_mixed_view(page);
    await open(page, `#narrow/dm/${othello_id},${hamlet_id}`);
    const group_direct = await is_mixed_view(page);
    await page.goto(`${base_url}#conversations/channel/${stream_id}-fragments`);
    await page.waitForSelector(".focused-message-list.conversations-view .message_row", {
        visible: true,
    });
    const conversations = await is_mixed_view(page);
    check(
        "a topic, an open conversation, a direct message, a group and the conversations view are not mixed views",
        [classic_topic, open_conversation, direct, group_direct, conversations].every(
            (state) => !state.mixed && state.fragments === 0,
        ),
        JSON.stringify({classic_topic, open_conversation, direct, group_direct, conversations}),
    );

    // A channel color change recolors the icon, not the header.
    await open(page, "#feed");
    await page.waitForSelector(row(ids.plans[0]!), {visible: true});
    await api(
        page,
        "POST",
        "/json/users/me/subscriptions/properties",
        `subscription_data=${encodeURIComponent(
            JSON.stringify([{stream_id, property: "color", value: "#ff0000"}]),
        )}`,
    );
    await page.waitForFunction(
        (selector: string) =>
            getComputedStyle(
                document
                    .querySelector(selector)!
                    .closest(".recipient_row")!
                    .querySelector(".conversation-fragment-channel-icon")!,
            ).backgroundColor === "rgb(255, 0, 0)",
        {timeout: 10000},
        row(ids.plans[0]!),
    );
    const recolored = await page.$eval(row(ids.plans[0]!), (row) => ({
        header: getComputedStyle(row.closest(".recipient_row")!.querySelector(".message-header-contents")!)
            .backgroundColor,
        row: getComputedStyle(row).backgroundColor,
    }));
    check(
        "a channel color change recolors the fragment icon and leaves the header the card color",
        recolored.header === recolored.row,
        JSON.stringify(recolored),
    );

    // Copying messages from two fragments names their conversations,
    // without the links.
    const copied = await page.evaluate(
        (start: string, end: string) => {
            const range = document.createRange();
            range.setStartBefore(document.querySelector(`${start} .message_content`)!);
            range.setEndAfter(document.querySelector(`${end} .message_content`)!);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
            const clipboard_data = new DataTransfer();
            document.dispatchEvent(
                new ClipboardEvent("copy", {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: clipboard_data,
                }),
            );
            window.getSelection()!.removeAllRanges();
            return clipboard_data
                .getData("text/plain")
                .split("\n")
                .filter((line) => line !== "");
        },
        row(ids.dm),
        row(ids.plans[2]!),
    );
    check(
        "copied messages name their conversations without the links",
        copied[0]?.startsWith("Direct messages > Othello, the Moor of Venice |") === true &&
            copied.some((line) => line.startsWith("fragments > plans |")) &&
            !copied.some((line) => line.includes("Open")),
        JSON.stringify(copied),
    );

    // Dark theme.
    await api(page, "PATCH", "/json/settings", "color_scheme=2");
    await open(page, "#feed");
    await page.waitForSelector(row(ids.plans[0]!), {visible: true});
    await page.$eval(row(ids.plans[0]!), (row) => {
        row.scrollIntoView({block: "center"});
    });
    const dark = await page.$eval(row(ids.plans[0]!), (row) => ({
        header: getComputedStyle(row.closest(".recipient_row")!.querySelector(".message-header-contents")!)
            .backgroundColor,
        row: getComputedStyle(row).backgroundColor,
        feed: getComputedStyle(document.body).backgroundColor,
    }));
    check(
        "in the dark theme the card has its own color too",
        dark.header === dark.row && dark.header !== dark.feed,
        JSON.stringify(dark),
    );
    await shot(page, "dark");

    // A narrow window.
    await page.setViewport({width: 480, height: 1000});
    await open(page, "#feed");
    await page.waitForSelector(row(ids.long_topic), {visible: true});
    await page.$eval(row(ids.long_topic), (row) => {
        row.scrollIntoView({block: "center"});
    });
    const narrow = await page.evaluate(() =>
        [...document.querySelectorAll(".focused-message-list .conversation-fragment-header")].map(
            (header) => {
                const contents = header.querySelector(".message-header-contents")!;
                const link = header.querySelector(".conversation-fragment-open")!;
                const topic = header.querySelector(".stream_topic a");
                return {
                    overflows: contents.scrollWidth > contents.clientWidth + 1,
                    link_inside:
                        link.getBoundingClientRect().right <=
                        contents.getBoundingClientRect().right + 1,
                    topic_cut: topic !== null && topic.scrollWidth > topic.clientWidth,
                };
            },
        ),
    );
    check(
        "in a 480px window headers fit, with the link in view and long topics cut",
        narrow.every((header) => !header.overflows && header.link_inside) &&
            narrow.some((header) => header.topic_cut),
        JSON.stringify(narrow.filter((header) => header.overflows || !header.link_inside)),
    );
    await shot(page, "480");
    await page.setViewport({width: 1280, height: 1000});

    // Russian.
    await api(page, "PATCH", "/json/settings", "default_language=ru");
    // A new language takes effect when the web app loads again.
    await page.reload();
    await open(page, "#feed");
    await page.waitForSelector(row(ids.dm), {visible: true});
    const ru_dm = await header_of(page, ids.dm);
    const ru_plans = await header_of(page, ids.plans[0]!);
    check(
        "the headers are translated",
        ru_dm.label.startsWith("Личные сообщения") &&
            ru_dm.open_text === "Открыть чат" &&
            ru_plans.open_text === "Открыть беседу",
        JSON.stringify({dm: ru_dm.label, open_chat: ru_dm.open_text, open: ru_plans.open_text}),
    );
    await api(page, "PATCH", "/json/settings", "default_language=en&color_scheme=1");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(conversation_fragments_test);
