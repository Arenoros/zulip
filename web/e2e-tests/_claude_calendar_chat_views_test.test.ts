import {execSync} from "node:child_process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-chat-views";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.message_send import check_send_stream_message
from zerver.lib.calendar.changes import create_calendar_event, get_or_create_calendar_event_chat
from zerver.models import Stream
from zerver.models.clients import get_client
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)


desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
hamlet = user("hamlet@zulip.com")
MOSCOW = ZoneInfo("Europe/Moscow")
`;

// Othello organizes a meeting with Desdemona and Hamlet tomorrow and
// opens its chat.
const seed_script =
    python_prelude +
    String.raw`
tomorrow = datetime.now(MOSCOW).date() + timedelta(days=1)
event_id = create_calendar_event(
    othello,
    title="Design review",
    start=datetime(tomorrow.year, tomorrow.month, tomorrow.day, 15, tzinfo=MOSCOW),
    end=datetime(tomorrow.year, tomorrow.month, tomorrow.day, 16, tzinfo=MOSCOW),
    event_timezone="Europe/Moscow",
    required_attendees=[desdemona, hamlet],
    optional_attendees=[],
    rrule="",
)
chat = get_or_create_calendar_event_chat(othello, event_id)
print("SEEDED " + json.dumps({"stream_id": chat.id}))
`;

async function request(page: Page, method: string, url: string, body: string): Promise<void> {
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
        throw new Error(`${method} ${url} ${body} failed with ${status}`);
    }
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function is_shown(page: Page, selector: string): Promise<boolean> {
    return await page.$$eval(selector, (elements) =>
        elements.some((element) => element.getClientRects().length > 0),
    );
}

async function text(page: Page, selector: string): Promise<string> {
    return await page.$eval(selector, (element) =>
        element.textContent.trim().replaceAll(/\s+/g, " "),
    );
}

async function count_or_zero(page: Page, selector: string): Promise<number> {
    const $element = await page.$(selector);
    if ($element === null || !(await is_shown(page, selector))) {
        return 0;
    }
    return Number(await text(page, selector));
}

async function wait_for_reply_label(page: Page, label: string): Promise<void> {
    await page.waitForFunction(
        (label) =>
            document
                .querySelector("#left_bar_compose_reply_button_big")
                ?.textContent.trim()
                .replaceAll(/\s+/g, " ") === label,
        {timeout: 5000},
        label,
    );
}

async function calendar_chat_views_test(page: Page): Promise<void> {
    const {stream_id} = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as {
        stream_id: number;
    };
    const inbox_row = `#inbox-direct-messages-container .inbox-row[data-meeting-chat-stream-id="${stream_id}"]`;
    const recent_row = `#recent-view-content-tbody tr[data-meeting-chat-stream-id="${stream_id}"]`;

    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // A new message in the chat shows it among direct messages.
    await page.goto(`${base_url}#inbox`);
    await page.reload();
    await page.waitForSelector("#inbox-main", {visible: true});
    // The direct messages header shows its counts when collapsed.
    await page.click("#inbox-dm-header .inbox-left-part-wrapper");
    await page.waitForSelector("#inbox-dm-header.inbox-collapsed-state");
    const dms_before = await count_or_zero(page, "#inbox-dm-header .unread_count");
    await page.click("#inbox-dm-header .inbox-left-part-wrapper");
    await page.waitForSelector("#inbox-dm-header:not(.inbox-collapsed-state)");
    run_python(
        python_prelude +
            String.raw`
chat = Stream.objects.get(id=${stream_id})
check_send_stream_message(othello, get_client("test"), chat.name, "", "@**Desdemona** the slides are up")
`,
    );
    await page.waitForSelector(inbox_row, {visible: true});
    check("a new message shows the chat in the inbox", true);
    check(
        "the inbox names the chat after the meeting",
        (await text(page, `${inbox_row} .recipients_name`)) === "Design review" &&
            (await page.$(`${inbox_row} .zulip-icon-calendar`)) !== null,
        await text(page, `${inbox_row} .recipients_name`),
    );
    check(
        "the inbox leaves it out of channels",
        (await page.$(`#inbox-stream-header-${stream_id}`)) === null,
    );
    check(
        "its unread message and mention count in its row",
        (await text(page, `${inbox_row} .unread_count`)) === "1" &&
            (await is_shown(page, `${inbox_row} .unread_mention_info`)),
    );
    // The direct messages header shows its counts when collapsed.
    await page.click("#inbox-dm-header .inbox-left-part-wrapper");
    await page.waitForSelector("#inbox-dm-header.inbox-collapsed-state");
    check(
        "and among direct messages",
        (await count_or_zero(page, "#inbox-dm-header .unread_count")) === dms_before + 1 &&
            (await is_shown(page, "#inbox-dm-header .unread_mention_info")),
        `${dms_before} -> ${await text(page, "#inbox-dm-header .unread_count")}`,
    );
    await page.click("#inbox-dm-header .inbox-left-part-wrapper");
    await page.waitForSelector(inbox_row, {visible: true});
    await shot(page, "inbox-dark");

    // The search finds it by the meeting's name.
    await page.click("#inbox-search");
    await page.keyboard.type("design");
    await page.waitForFunction(
        (selector) => !document.querySelector(selector)?.classList.contains("hidden_by_filters"),
        {},
        inbox_row,
    );
    const shown_for_design = await is_shown(page, inbox_row);
    await page.keyboard.type("zzz");
    await page.waitForFunction(
        (selector) => document.querySelector(selector)?.classList.contains("hidden_by_filters"),
        {timeout: 5000},
        inbox_row,
    );
    check("the inbox search finds it by name", shown_for_design);

    // With the keyboard, the closed compose box replies to the chat.
    await page.click("#inbox-search", {count: 3});
    await page.keyboard.press("Backspace");
    await page.keyboard.type("design review");
    await page.waitForFunction(
        (selector) => !document.querySelector(selector)?.classList.contains("hidden_by_filters"),
        {},
        inbox_row,
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
        (selector) => document.activeElement === document.querySelector(selector),
        {timeout: 5000},
        inbox_row,
    );
    await wait_for_reply_label(page, "Message Design review");
    check("the focused row replies to the chat", true);

    // Its unread count marks it as read.
    await page.click(`${inbox_row} .unread-count-focus-outline`);
    await page.waitForSelector(inbox_row, {hidden: true});
    check("marking it as read takes it off the inbox", (await page.$(inbox_row)) === null);
    await page.click("#inbox-search", {count: 3});
    await page.keyboard.press("Backspace");

    // Recent conversations show it like a direct message, when they
    // include direct messages.
    await page.goto(`${base_url}#recent`);
    await page.waitForSelector("#recent-view-content-tbody tr", {visible: true});
    const filter = '.button-recent-filters[data-filter="include_private"]';
    const hidden_without_dms =
        !(await page.$eval(filter, (element) =>
            element.classList.contains("button-recent-selected"),
        )) && (await page.$(recent_row)) === null;
    await page.click(filter);
    await page.waitForSelector(recent_row, {visible: true});
    check("the direct messages filter shows it", hidden_without_dms);
    check(
        "recent conversations show it as a meeting",
        (await text(page, `${recent_row} .recent-view-dm-name`)) === "Meeting" &&
            (await text(page, `${recent_row} .recent-view-conversation-link`)) ===
                "Design review" &&
            (await page.$(`${recent_row} .zulip-icon-calendar`)) !== null,
        await text(page, `${recent_row} .recent_topic_name`),
    );
    check(
        "it has no topic menu",
        (await page.$(`${recent_row} .recent-view-topic-visibility`)) === null,
    );
    await shot(page, "recent-dark");

    // With the keyboard, the closed compose box replies to the chat.
    await page.click("#recent_view_search");
    await page.keyboard.type("design review");
    await page.waitForFunction(
        (selector) =>
            document.querySelectorAll("#recent-view-content-tbody tr").length === 1 &&
            document.querySelector(selector) !== null,
        {timeout: 5000},
        recent_row,
    );
    await page.keyboard.press("ArrowDown");
    await wait_for_reply_label(page, "Message Design review");
    check("the focused recent row replies to the chat", true);
    await page.waitForFunction(
        (selector) => document.querySelector(selector)?.contains(document.activeElement),
        {timeout: 5000},
        recent_row,
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    check(
        "keyboard focus stays within the row's columns",
        await page.evaluate(
            (selector) =>
                document.querySelector(selector)?.contains(document.activeElement) ?? false,
            recent_row,
        ),
        await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? ""),
    );

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await page.reload();
    await page.waitForSelector(recent_row, {visible: true});
    check(
        "the meeting label is in Russian",
        (await text(page, `${recent_row} .recent-view-dm-name`)) === "Встреча",
        await text(page, `${recent_row} .recent-view-dm-name`),
    );
    await shot(page, "recent-light-ru");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_chat_views_test);
