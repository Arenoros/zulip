import {execSync} from "node:child_process";

import puppeteer, {type Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "mixed-view-rows";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// A topic today where Hamlet writes twice within five minutes, then
// again after a longer pause, and Iago answers; a starred message of
// Hamlet's; a message from a bot; one that mentions Desdemona; one of
// Desdemona's own; and an unread message at the end.
const seed_script = String.raw`import json
from datetime import timedelta

from django.conf import settings
from django.db.models import F
from django.utils.timezone import now as timezone_now

from zerver.actions.message_flags import do_update_message_flags
from zerver.actions.message_send import internal_send_stream_message
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.models import Message, UserMessage
from zerver.models.realms import get_realm
from zerver.models.users import get_system_bot, get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
welcome_bot = get_system_bot(settings.WELCOME_BOT, realm.id)

stream, _ = create_stream_if_needed(realm, "rows", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, iago, hamlet], acting_user=None)
today = timezone_now().replace(hour=9, minute=0, second=0, microsecond=0)


def send(sender, topic, content, minutes):
    message_id = internal_send_stream_message(sender, stream, topic, content)
    Message.objects.filter(id=message_id).update(date_sent=today + timedelta(minutes=minutes))
    return message_id


ids = {
    "series": [
        send(hamlet, "series", "First message.", 0),
        send(hamlet, "series", "Within five minutes.", 3),
        send(hamlet, "series", "After a pause.", 10),
        send(iago, "series", "An answer.", 11),
    ],
    "starred": send(hamlet, "stars", "A starred message.", 20),
    "bot": send(welcome_bot, "bots", "A message from a bot.", 21),
    "mention": send(iago, "mentions", "@**Desdemona** have a look.", 22),
    "own": send(desdemona, "own", "My own message.", 23),
}
UserMessage.objects.filter(user_profile=desdemona).update(
    flags=F("flags").bitor(UserMessage.flags.read)
)
ids["unread"] = send(iago, "unread", "Not read yet.", 24)
do_update_message_flags(desdemona, "add", "starred", [ids["starred"]])

print("SEEDED " + json.dumps({"ids": ids, "stream_id": stream.id}))
`;

type Seeded = {
    ids: {
        series: number[];
        starred: number;
        bot: number;
        mention: number;
        own: number;
        unread: number;
    };
    stream_id: number;
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

async function open(page: Page, hash: string, id: number): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.waitForSelector(row(id), {visible: true});
    await page.$eval(row(id), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function senders_shown(page: Page, ids: number[]): Promise<boolean[]> {
    return await Promise.all(
        ids.map(
            async (id) =>
                await page.$eval(row(id), (row) =>
                    row.classList.contains("messagebox-includes-sender"),
                ),
        ),
    );
}

type Line = {
    avatar: number;
    name_right: number;
    name_top: number;
    time_left: number;
    time_right: number;
    time_top: number;
    time_visible: boolean;
    star_shown: boolean;
    star_left: number;
    star_color: string;
    control_star_visible: boolean;
    classes: string;
};

async function line_of(page: Page, id: number): Promise<Line> {
    return await page.$eval(row(id), (row) => {
        const box = (element: Element | null): DOMRect =>
            element?.getBoundingClientRect() ?? new DOMRect();
        const avatar = row.querySelector(".message-avatar .inline_profile_picture");
        const name = row.querySelector(".sender_name");
        const time = row.querySelector(".message-time")!;
        const star = row.querySelector(".message-starred-indicator");
        const control_star = row.querySelector(".message_controls .star_container");
        return {
            avatar: Math.round(box(avatar).width),
            name_right: Math.round(box(name).right),
            name_top: Math.round(box(name).top),
            time_left: Math.round(box(time).left),
            time_right: Math.round(box(time).right),
            time_top: Math.round(box(time).top),
            time_visible: getComputedStyle(time).visibility === "visible",
            star_shown: star !== null && getComputedStyle(star).display !== "none",
            star_left: Math.round(box(star).left),
            star_color: star ? getComputedStyle(star).color : "",
            control_star_visible:
                control_star !== null && getComputedStyle(control_star).visibility === "visible",
            classes: row.className,
        };
    });
}

async function hover(page: Page, id: number): Promise<void> {
    const point = await page.$eval(row(id), (row) => {
        const box = row.querySelector(".message_content")!.getBoundingClientRect();
        return {x: box.left + 20, y: box.top + box.height / 2};
    });
    await page.mouse.move(point.x, point.y);
    await new Promise((resolve) => setTimeout(resolve, 600));
}

async function mixed_view_rows_test(page: Page): Promise<void> {
    const output = run_python(seed_script);
    const {ids, stream_id} = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await api(
        page,
        "PATCH",
        "/json/settings",
        "web_channel_default_view=5&color_scheme=3&web_font_size_px=15&timezone=UTC&twenty_four_hour_time=false",
    );
    // The text size takes effect when the web app loads again.
    await page.reload();

    // Series.
    await open(page, "#feed", ids.series[0]!);
    check(
        "in a mixed view, a pause of more than five minutes starts a new series",
        JSON.stringify(await senders_shown(page, ids.series)) ===
            JSON.stringify([true, false, true, true]),
        JSON.stringify(await senders_shown(page, ids.series)),
    );
    const new_messages_dividers = await page.$$eval(
        ".focused-message-list .new-messages-divider",
        (dividers) => dividers.length,
    );
    check("a mixed view has no new messages divider", new_messages_dividers === 0);

    // Name, time and avatar.
    const first = await line_of(page, ids.series[0]!);
    check(
        "the avatar is 32px and the time follows the name on the same line",
        first.avatar === 32 &&
            first.time_left - first.name_right >= 6 &&
            first.time_left - first.name_right <= 10 &&
            Math.abs(first.time_top - first.name_top) <= 4 &&
            first.time_visible,
        JSON.stringify(first),
    );
    // Headless Chrome reports a device without hover, where the time
    // of every message shows, so this check runs in a browser that
    // reports a mouse.
    const hover_browser = await puppeteer.launch({
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
        defaultViewport: {width: 1280, height: 1000},
        headless: true,
    });
    try {
        const hover_page = await hover_browser.newPage();
        await hover_page.emulateTimezone("UTC");
        await common.log_in(hover_page);
        await open(hover_page, "#feed", ids.series[0]!);
        const can_hover = await hover_page.evaluate(
            () => window.matchMedia("(hover: hover)").matches,
        );
        // The selected message shows its time, so select another one.
        await hover_page.evaluate((id: number) => {
            zulip_test.current_msg_list!.select_id(id);
        }, ids.series[3]!);
        await hover_page.mouse.move(1, 1);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const second = await line_of(hover_page, ids.series[1]!);
        await hover(hover_page, ids.series[1]!);
        const second_hovered = await line_of(hover_page, ids.series[1]!);
        check(
            "the time of a later message in a series shows on hover",
            can_hover && !second.time_visible && second_hovered.time_visible,
            JSON.stringify({
                can_hover,
                before: second.time_visible,
                hovered: second_hovered.time_visible,
            }),
        );
    } finally {
        await hover_browser.close();
    }
    await page.mouse.move(1, 1);
    await shot(page, "series");

    // Stars.
    await page.$eval(row(ids.starred), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const starred = await line_of(page, ids.starred);
    await hover(page, ids.starred);
    const starred_hovered = await line_of(page, ids.starred);
    check(
        "a starred message has a star next to its time; the star among the controls shows on hover",
        starred.star_shown &&
            starred.star_left - starred.time_right >= 6 &&
            starred.star_left - starred.time_right <= 10 &&
            !starred.control_star_visible &&
            starred_hovered.control_star_visible,
        JSON.stringify({starred, hovered: starred_hovered.control_star_visible}),
    );
    // Unstarring and starring again updates the star next to the time.
    await page.click(`${row(ids.starred)} .star_container .star`);
    await page.waitForFunction(
        (selector: string) =>
            getComputedStyle(document.querySelector(`${selector} .message-starred-indicator`)!)
                .display === "none",
        {timeout: 5000},
        row(ids.starred),
    );
    await page.click(`${row(ids.starred)} .star_container .star`);
    const restarred = await page
        .waitForFunction(
            (selector: string) =>
                getComputedStyle(
                    document.querySelector(`${selector} .message-starred-indicator`)!,
                ).display !== "none",
            {timeout: 5000},
            row(ids.starred),
        )
        .then(() => true)
        .catch(() => false);
    check("unstarring and starring updates the star next to the time", restarred);
    const plain = await line_of(page, ids.series[0]!);
    check("a message that is not starred has no star", !plain.star_shown);
    await page.mouse.move(1, 1);
    await shot(page, "star");

    // Bots, mentions, own messages, unread messages.
    const bot = await page.$eval(row(ids.bot), (row) => {
        const label = row.querySelector(".message-sender-bot-label")!;
        const icon = row.querySelector(".message_sender .zulip-icon-bot");
        return {
            label: getComputedStyle(label).display !== "none" ? label.textContent.trim() : "",
            icon: icon !== null && getComputedStyle(icon).display !== "none",
        };
    });
    check(
        "a bot's name has a Bot label instead of the icon",
        bot.label === "Bot" && !bot.icon,
        JSON.stringify(bot),
    );
    const mention = await page.$eval(row(ids.mention), (row) => {
        const chip = row.querySelector(".user-mention-me")!;
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--color-background-self-mention-in-bubble)";
        row.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {chip: getComputedStyle(chip).backgroundColor, expected};
    });
    check(
        "a mention of me is a yellow chip, as in bubbles",
        mention.chip === mention.expected && mention.chip !== "rgba(0, 0, 0, 0)",
        JSON.stringify(mention),
    );
    const own = await page.$eval(row(ids.own), (row) => ({
        name: row.querySelector(".sender_name")?.textContent.trim() ?? "",
        left: Math.round(row.querySelector(".message_content")!.getBoundingClientRect().left),
        others_left: Math.round(
            document
                .querySelector(".focused-message-list .messagebox-includes-sender .message_content")!
                .getBoundingClientRect().left,
        ),
    }));
    check(
        "my own messages are on the left with my name",
        own.name === "Desdemona" && own.left === own.others_left,
        JSON.stringify(own),
    );
    // The message is marked as read once shown, so this checks that
    // its marker is there to show it.
    const unread_marker = await page.$eval(
        row(ids.unread),
        (row) => getComputedStyle(row.querySelector(".message_unread_marker")!).display,
    );
    check(
        "messages keep Zulip's unread marker",
        unread_marker !== "none",
        unread_marker,
    );
    await shot(page, "states");

    // Actions.
    await page.$eval(row(ids.mention), (row) => {
        row.scrollIntoView({block: "center"});
    });
    const point = await page.$eval(row(ids.mention), (row) => {
        const box = row.querySelector(".message_content")!.getBoundingClientRect();
        return {x: box.left + 10, y: box.top + box.height / 2};
    });
    await page.mouse.click(point.x, point.y, {button: "right"});
    const menu = await page
        .waitForSelector("#message-actions-menu-dropdown", {visible: true, timeout: 5000})
        .then(() => true)
        .catch(() => false);
    check("right-clicking a message opens its actions menu", menu);
    await page.keyboard.press("Escape");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("Escape");
    await page.click(`${row(ids.mention)} .message_content`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("KeyR");
    const reply = await page
        .waitForFunction(
            () =>
                document.querySelector<HTMLInputElement>("input#stream_message_recipient_topic")
                    ?.value === "mentions",
            {timeout: 5000},
        )
        .then(() => true)
        .catch(() => false);
    const recipient_row_shown = await page.evaluate(
        () => getComputedStyle(document.querySelector("#compose-recipient")!).display !== "none",
    );
    check(
        "r replies to the conversation of the message, in the compose box with its recipient row",
        reply && recipient_row_shown,
        JSON.stringify({reply, recipient_row_shown}),
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Classic layout of a topic is unchanged.
    await api(page, "PATCH", "/json/settings", "web_channel_default_view=2");
    await open(page, `#narrow/channel/${stream_id}-rows/topic/series`, ids.series[0]!);
    // The view rerenders once the setting's event arrives.
    await page.waitForSelector(".focused-message-list:not(.open-conversation) .message_header", {
        visible: true,
    });
    const classic = await page.evaluate(() => ({
        mixed: document.querySelector(".focused-message-list")!.classList.contains("mixed-view"),
    }));
    check(
        "a topic in the classic layout ignores pauses",
        !classic.mixed &&
            JSON.stringify(await senders_shown(page, ids.series)) ===
                JSON.stringify([true, false, false, true]),
        JSON.stringify(await senders_shown(page, ids.series)),
    );
    await api(page, "PATCH", "/json/settings", "web_channel_default_view=5");

    // Dark theme, 24-hour time and larger text.
    await api(
        page,
        "PATCH",
        "/json/settings",
        "color_scheme=2&twenty_four_hour_time=true&web_font_size_px=17",
    );
    await page.reload();
    await open(page, "#feed", ids.starred);
    const large = await line_of(page, ids.starred);
    const time_text = await page.$eval(
        `${row(ids.starred)} .message-time`,
        (time) => time.textContent.trim(),
    );
    check(
        "with 24-hour time and 17px text the line keeps its layout",
        time_text === "09:20" &&
            large.star_shown &&
            large.time_left > large.name_right &&
            large.star_left > large.time_right,
        JSON.stringify({time_text, large}),
    );
    await shot(page, "dark-24h-17px");

    await page.setViewport({width: 480, height: 1000});
    await open(page, "#feed", ids.starred);
    const narrow = await page.evaluate(() =>
        [...document.querySelectorAll(".focused-message-list .messagebox-includes-sender")].filter(
            (row) => row.scrollWidth > row.clientWidth + 1,
        ).length,
    );
    check("in a 480px window no row overflows", narrow === 0, String(narrow));
    await shot(page, "480");

    await api(
        page,
        "PATCH",
        "/json/settings",
        "color_scheme=1&twenty_four_hour_time=false&web_font_size_px=15",
    );
    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(mixed_view_rows_test);
