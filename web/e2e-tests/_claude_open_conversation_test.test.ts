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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "open-conversation";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import timedelta

from django.db.models import F
from django.utils.timezone import now as timezone_now

from zerver.actions.message_send import internal_send_stream_message
from zerver.models import Message, UserMessage
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
`;

// A topic that starts two days ago and has two unread replies today,
// newer topics enough to fill more than a page of cards, and a long
// topic.
const seed_script =
    python_prelude +
    String.raw`
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed

stream, _ = create_stream_if_needed(realm, "offsite", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, iago, hamlet, othello], acting_user=None)
today = timezone_now().replace(hour=9, minute=0, second=0, microsecond=0)
two_days_ago = today - timedelta(days=2)


def send(sender, topic, content, date_sent):
    message_id = internal_send_stream_message(sender, stream, topic, content)
    Message.objects.filter(id=message_id).update(date_sent=date_sent)
    return message_id


ids = {}
ids["venue"] = [
    send(hamlet, "venue", "Where do we meet?", two_days_ago),
    send(othello, "venue", "The old mill.", two_days_ago + timedelta(minutes=1)),
    send(othello, "venue", "It has a big hall.", two_days_ago + timedelta(minutes=3)),
    send(iago, "venue", "I will book it.", two_days_ago + timedelta(minutes=20)),
    send(othello, "venue", "Booked?", today),
    send(hamlet, "venue", "Yes, for Friday.", today + timedelta(minutes=1)),
]
for i in range(1, 26):
    send(iago, f"newer {i:02}", f"Newer topic {i}.", today + timedelta(minutes=10 + i))
ids["history"] = [
    send(iago if i % 2 else othello, "history", f"History message {i}.", today + timedelta(minutes=40))
    for i in range(80)
]

# Desdemona has read everything but the two replies today.
UserMessage.objects.filter(user_profile=desdemona, message__recipient=stream.recipient).update(
    flags=F("flags").bitor(UserMessage.flags.read)
)
UserMessage.objects.filter(user_profile=desdemona, message_id__in=ids["venue"][4:]).update(
    flags=F("flags").bitand(~UserMessage.flags.read)
)

print("SEEDED " + json.dumps({"ids": ids, "stream_id": stream.id}))
`;

type Seeded = {ids: Record<string, number[]>; stream_id: number};

async function set_setting(page: Page, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(async (body) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                ?.value ?? "";
        const response = await fetch("/json/settings", {
            method: "PATCH",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-CSRFToken": csrf_token,
            },
            body,
        });
        return response.status;
    }, body);
    if (status !== 200) {
        throw new Error(`PATCH /json/settings ${body}: ${status}`);
    }
}

function row(id: number): string {
    return `.focused-message-list .message_row[data-message-id="${id}"]`;
}

async function replies_label(page: Page): Promise<string | undefined> {
    return await page.evaluate(
        () =>
            document
                .querySelector(".focused-message-list .open-conversation-replies-label")
                ?.textContent.trim(),
    );
}

async function wait_for_replies_label(page: Page, label: string): Promise<boolean> {
    try {
        await page.waitForFunction(
            (label: string) =>
                document
                    .querySelector(".focused-message-list .open-conversation-replies-label")
                    ?.textContent.trim() === label,
            {timeout: 10000},
            label,
        );
        return true;
    } catch {
        return false;
    }
}

async function open_topic(page: Page, stream_id: number, topic: string): Promise<void> {
    await page.goto(`${base_url}#narrow/channel/${stream_id}-offsite/topic/${topic}`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    await page.mouse.move(1, 1);
}

// The feed may first show the messages the web app already has, and
// the card once the server confirms the topic's first message.
async function wait_for_card(page: Page): Promise<void> {
    await page.waitForSelector(".focused-message-list .open-conversation-first-message", {
        visible: true,
    });
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function open_conversation_test(page: Page): Promise<void> {
    const output = run_python(seed_script);
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    const {ids, stream_id} = seeded;
    const venue = ids["venue"]!;
    const history = ids["history"]!;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await set_setting(
        page,
        "web_channel_default_view=5&color_scheme=3&web_font_size_px=15&timezone=UTC",
    );

    await open_topic(page, stream_id, "venue");
    await wait_for_card(page);

    // The feed.
    const layout = await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!;
        return {
            classes: [...list.classList],
            recipient_bars_shown: [...list.querySelectorAll(".message_header")].filter(
                (header) => getComputedStyle(header).display !== "none",
            ).length,
        };
    });
    check(
        "a topic opens as an open conversation, without recipient bars",
        layout.classes.includes("open-conversation") &&
            layout.classes.includes("chat-layout") &&
            !layout.classes.includes("bubble-layout") &&
            layout.recipient_bars_shown === 0,
        JSON.stringify(layout),
    );

    const card = await page.$eval(row(venue[0]!), (row) => {
        const box = row.querySelector(".messagebox")!;
        const style = getComputedStyle(box);
        return {
            is_card: row.classList.contains("open-conversation-first-message"),
            first_row: row === document.querySelector(".focused-message-list .message_row"),
            radius: style.borderRadius,
            border: style.borderTopWidth,
            date_divider: row.querySelector(".date-divider-content") !== null,
            time: row.querySelector(".message-time")!.textContent.trim(),
            replies_below:
                row.querySelector(".open-conversation-replies")!.getBoundingClientRect().top >=
                box.getBoundingClientRect().bottom,
        };
    });
    check(
        "the topic's first message is a card, with its date next to its time",
        card.is_card &&
            card.first_row &&
            card.radius === "8px" &&
            card.border === "1px" &&
            !card.date_divider &&
            card.time.includes(" at ") &&
            card.replies_below,
        JSON.stringify(card),
    );
    check(
        "under the card, the number of replies from the server",
        await wait_for_replies_label(page, "5 replies"),
        await replies_label(page),
    );

    const rows = await page.evaluate(
        (venue: number[]) =>
            venue.map((id) => {
                const row = document.querySelector(
                    `.focused-message-list .message_row[data-message-id="${id}"]`,
                )!;
                const name = row.querySelector(".sender_name")?.getBoundingClientRect();
                const time = row.querySelector(".message-time")!.getBoundingClientRect();
                return {
                    sender: row.classList.contains("messagebox-includes-sender"),
                    date_divider:
                        row.querySelector(".date-divider-content")?.textContent.trim() ?? "",
                    new_messages: row.querySelector(".new-messages-divider") !== null,
                    time_after_name:
                        name === undefined
                            ? null
                            : Math.abs(time.bottom - name.bottom) < 4 && time.left > name.right,
                };
            }),
        venue,
    );
    check(
        "replies start series after the card and after a pause",
        JSON.stringify(rows.map((row) => row.sender)) ===
            JSON.stringify([true, true, false, true, true, true]),
        JSON.stringify(rows.map((row) => row.sender)),
    );
    check(
        "a date divider starts today's replies, after the new messages divider",
        rows[4]!.date_divider === "Today" &&
            rows[4]!.new_messages &&
            rows.filter((row) => row.date_divider !== "").length === 1 &&
            rows.filter((row) => row.new_messages).length === 1,
        JSON.stringify(rows.map((row) => [row.date_divider, row.new_messages])),
    );
    check(
        "each series shows the sender's name and the time on one line",
        rows.every((row) => row.time_after_name !== false) &&
            rows.filter((row) => row.time_after_name === true).length === 5,
        JSON.stringify(rows.map((row) => row.time_after_name)),
    );

    // The header.
    const header = await page.evaluate(() => {
        const header = document.querySelector("#message_view_header .open-conversation-header");
        return {
            back: header?.querySelector(".open-conversation-back")?.getAttribute("href"),
            channel: header?.querySelector(".open-conversation-header-channel")?.textContent.trim(),
            topic: header?.querySelector(".open-conversation-header-topic")?.textContent.trim(),
            actions: [
                ...(header?.querySelectorAll(".open-conversation-header-actions > *") ?? []),
            ].map((action) => action.classList[0]),
        };
    });
    check(
        "the header leads back, names the channel and the topic, and offers the topic's actions",
        header.back === `#conversations/channel/${stream_id}-offsite` &&
            header.channel === "offsite" &&
            header.topic === "venue" &&
            JSON.stringify(header.actions) ===
                JSON.stringify([
                    "open-conversation-resolve",
                    "open-conversation-rename",
                    "change_visibility_policy",
                    "open-conversation-copy-link",
                    "open-conversation-topic-menu",
                ]),
        JSON.stringify(header),
    );
    await shot(page, "light");

    // Replies arriving, from others and from oneself.
    run_python(
        python_prelude +
            String.raw`
stream = get_stream("offsite", realm)
internal_send_stream_message(iago, stream, "venue", "I booked the bus too.")
`,
    );
    check(
        "a reply from someone else updates the number of replies",
        await wait_for_replies_label(page, "6 replies"),
        await replies_label(page),
    );
    await page.keyboard.press("KeyR");
    await page.waitForSelector("#compose-textarea", {visible: true});
    await page.type("#compose-textarea", "See you at the mill.");
    await page.keyboard.press("Enter");
    const own_reply_counted = await wait_for_replies_label(page, "7 replies");
    await page.waitForFunction(
        () =>
            document.querySelectorAll(".focused-message-list .message_row.locally-echoed")
                .length === 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    check(
        "one's own reply counts as soon as it is sent, and stays counted",
        own_reply_counted && (await replies_label(page)) === "7 replies",
        await replies_label(page),
    );

    // The header's actions.
    await page.click(".open-conversation-copy-link");
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".tippy-content")].some(
            (tooltip) => tooltip.textContent.trim() === "Copied!",
        ),
    );
    check("the link button copies the link to the topic", true);

    await page.click(".open-conversation-topic-menu");
    await page.waitForSelector("#topic-actions-menu-popover", {visible: true});
    check(
        "the menu button opens the topic's menu",
        await page.$eval("#topic-actions-menu-popover", (menu) =>
            menu.textContent.includes("venue"),
        ),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector("#topic-actions-menu-popover", {hidden: true});

    await page.click(".open-conversation-rename");
    await page.waitForSelector(".micromodal.modal--open .modal__container", {visible: true});
    check(
        "the rename button opens the rename dialog for the topic",
        await page.$eval(".micromodal.modal--open", (modal) => modal.textContent.includes("venue")),
    );
    await page.click(".micromodal.modal--open .dialog_exit_button");
    await page.waitForFunction(() => document.querySelector(".micromodal.modal--open") === null);

    await page.click(".open-conversation-header .change_visibility_policy");
    await page.waitForSelector(".visibility-policy-popover", {visible: true});
    await page.click('.visibility-policy-popover label[for="select-followed-policy"]');
    await page.waitForSelector(".open-conversation-header .zulip-icon-follow", {visible: true});
    check("the bell sets the topic's visibility policy and shows it", true);

    await page.click(".open-conversation-resolve");
    await page.waitForFunction(
        () =>
            document.querySelector(
                "#message_view_header .open-conversation-header-topic .topic-card-resolved-label",
            ) !== null &&
            document.querySelector("#message_view_header .open-conversation-resolve .zulip-icon-check-x") !==
                null,
    );
    const resolved_title = await page.$eval(
        "#message_view_header .open-conversation-header-topic .message-header-navbar-title",
        (title) => title.textContent.trim(),
    );
    check(
        "resolving the topic labels it in the header, without the check mark in the name",
        resolved_title === "venue",
        resolved_title,
    );
    await page.click(".open-conversation-resolve");
    await page.waitForFunction(
        () =>
            document.querySelector(
                "#message_view_header .open-conversation-header-topic .topic-card-resolved-label",
            ) === null,
    );
    check("the same button unresolves the topic", true);

    // Back to the topic's card, which is not on the first page.
    await page.click(".open-conversation-back");
    await page.waitForSelector(".focused-message-list.conversations-view .selected_message", {
        visible: true,
    });
    const back = await page.evaluate(() => {
        const selected = document.querySelector(".focused-message-list .selected_message")!;
        const card = selected.closest(".recipient_row")!;
        const box = card.getBoundingClientRect();
        return {
            hash: window.location.hash,
            card: card.querySelector(".topic-card-title-text")?.textContent.trim(),
            in_view: box.top >= 0 && box.top < window.innerHeight,
            cards: document.querySelectorAll(".focused-message-list .recipient_row").length,
        };
    });
    check(
        "the back button shows the topic's card in the conversations view",
        back.hash === `#conversations/channel/${stream_id}-offsite` &&
            back.card === "venue" &&
            back.in_view &&
            back.cards > 20,
        JSON.stringify(back),
    );

    // A long topic opened near its end has its first message loaded
    // only on scrolling up.
    await page.goto(
        `${base_url}#narrow/channel/${stream_id}-offsite/topic/history/near/${history.at(-1)}`,
    );
    await page.waitForSelector(row(history.at(-1)!), {visible: true});
    const card_before_scrolling = await page.$(".focused-message-list .open-conversation-first-message");
    // Scrolling up moves the selection to the top, which loads the
    // older messages.
    await page.mouse.move(640, 500);
    for (let i = 0; i < 40; i += 1) {
        await page.mouse.wheel({deltaY: -600});
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (await page.$(".focused-message-list .open-conversation-first-message")) {
            break;
        }
    }
    const card_id = await page.evaluate(() =>
        Number(
            document.querySelector<HTMLElement>(
                ".focused-message-list .open-conversation-first-message",
            )?.dataset["messageId"],
        ),
    );
    check(
        "the card appears once the topic's first message is loaded",
        card_before_scrolling === null && card_id === history[0],
        `${card_before_scrolling === null} ${card_id}`,
    );
    check(
        "the number of replies comes from the server before the topic is loaded",
        await wait_for_replies_label(page, "79 replies"),
        await replies_label(page),
    );

    // Dark theme, and a narrow window.
    await set_setting(page, "color_scheme=2");
    await open_topic(page, stream_id, "venue");
    await wait_for_card(page);
    await wait_for_replies_label(page, "7 replies");
    await shot(page, "dark");
    await page.setViewport({width: 480, height: 900});
    await open_topic(page, stream_id, "venue");
    await wait_for_card(page);
    await wait_for_replies_label(page, "7 replies");
    const overflow = await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!.getBoundingClientRect();
        const header = document.querySelector("#message_view_header")!;
        return {
            rows: [...document.querySelectorAll(".focused-message-list .message_row")].filter(
                (row) => row.getBoundingClientRect().right > list.right + 1,
            ).length,
            header_overflows: header.scrollWidth > header.clientWidth,
        };
    });
    check(
        "in a 480px window, nothing overflows the feed or the header",
        overflow.rows === 0 && !overflow.header_overflows,
        JSON.stringify(overflow),
    );
    await shot(page, "dark-480");
    await page.setViewport({width: 1280, height: 1000});

    // 24-hour time and a larger font.
    await set_setting(page, "twenty_four_hour_time=true&web_font_size_px=17");
    await page.reload();
    await open_topic(page, stream_id, "venue");
    await wait_for_card(page);
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    });
    const large = await page.evaluate((first_id: number) => {
        const card = document.querySelector(
            `.focused-message-list .message_row[data-message-id="${first_id}"]`,
        )!;
        const list = document.querySelector(".focused-message-list")!.getBoundingClientRect();
        return {
            time: card.querySelector(".message-time")!.textContent.trim(),
            font: getComputedStyle(document.documentElement).getPropertyValue(
                "--base-font-size-px",
            ),
            overflowing: [...document.querySelectorAll(".focused-message-list .message_row")].filter(
                (row) => row.getBoundingClientRect().right > list.right + 1,
            ).length,
        };
    }, venue[0]!);
    check(
        "with 24-hour time and 17px text, the card shows its date and time and nothing overflows",
        / at 09:00$/.test(large.time) && large.font === "17px" && large.overflowing === 0,
        JSON.stringify(large),
    );
    await shot(page, "dark-24h-17px");
    await set_setting(page, "twenty_four_hour_time=false&web_font_size_px=15");

    // With another default view for channels, topics keep the classic
    // layout.
    await set_setting(page, "web_channel_default_view=1&color_scheme=3");
    await open_topic(page, stream_id, "venue");
    // The view rerenders once the setting's event arrives.
    await page.waitForSelector(".focused-message-list:not(.open-conversation) .message_header", {
        visible: true,
    });
    const classic = await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!;
        return {
            classes: [...list.classList],
            recipient_bar: getComputedStyle(list.querySelector(".message_header")!).display,
            card: list.querySelector(".open-conversation-first-message") !== null,
            header: document.querySelector(".open-conversation-header") !== null,
        };
    });
    check(
        "with the channel feed as default view, a topic keeps the classic layout",
        !classic.classes.includes("open-conversation") &&
            !classic.classes.includes("chat-layout") &&
            classic.recipient_bar !== "none" &&
            !classic.card &&
            !classic.header,
        JSON.stringify(classic),
    );

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(open_conversation_test);
