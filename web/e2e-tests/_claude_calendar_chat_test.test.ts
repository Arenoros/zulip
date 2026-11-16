import {execSync} from "node:child_process";

import type {Page} from "puppeteer";
import * as z from "zod/mini";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-chat";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.message_send import check_send_stream_message
from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event, update_calendar_event
from zerver.models import CalendarEvent, Subscription
from zerver.models.clients import get_client
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)


desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
hamlet = user("hamlet@zulip.com")
iago = user("iago@zulip.com")
MOSCOW = ZoneInfo("Europe/Moscow")
`;

// Othello organizes a weekly meeting on Wednesdays with Desdemona and
// Hamlet, which starts this week.
const seed_script =
    python_prelude +
    String.raw`
today = datetime.now(MOSCOW).date()
monday = today - timedelta(days=today.weekday())
wednesday = monday + timedelta(days=2)
do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
event_id = create_calendar_event(
    othello,
    title="Weekly sync",
    start=datetime(wednesday.year, wednesday.month, wednesday.day, 15, tzinfo=MOSCOW),
    end=datetime(wednesday.year, wednesday.month, wednesday.day, 16, tzinfo=MOSCOW),
    event_timezone="Europe/Moscow",
    required_attendees=[desdemona, hamlet],
    optional_attendees=[],
    rrule="FREQ=WEEKLY",
)
print("SEEDED " + json.dumps({"monday": monday.isoformat(), "event_id": event_id}))
`;

const seeded_schema = z.object({monday: z.string(), event_id: z.number()});

async function request(page: Page, method: string, url: string, body: string): Promise<unknown> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const [status, data] = await page.evaluate(
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
            const data: unknown = await response.json();
            return [response.status, data] as const;
        },
        method,
        url,
        body,
    );
    if (status !== 200) {
        throw new Error(`${method} ${url} ${body} failed with ${status}`);
    }
    return data;
}

function add_days(date: string, days: number): string {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
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

async function open_week(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.reload();
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-day-column", {
        visible: true,
    });
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
}

async function open_card(page: Page, date: string, title: string): Promise<void> {
    await page.click(
        `.calendar-day-column[data-date="${date}"] .calendar-event[aria-label^="${title},"]`,
    );
    await page.waitForSelector(".calendar-card", {visible: true});
}

async function wait_for_chat(page: Page, title: string): Promise<void> {
    await page.waitForFunction(
        (title) =>
            document.querySelector(".conversation-header .message-header-navbar-title")
                ?.textContent === title,
        {},
        title,
    );
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
}

async function calendar_chat_test(page: Page): Promise<void> {
    const {monday, event_id} = seeded_schema.parse(
        JSON.parse(run_python(seed_script).split("SEEDED ", 2)[1]!),
    );
    const wednesday = add_days(monday, 2);
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(
        page,
        "PATCH",
        "/json/settings",
        "color_scheme=2&web_font_size_px=14&web_direct_message_bubbles=true",
    );

    // "Discussion" in the card creates the chat and opens it.
    await open_week(page, `#calendar/workweek/${monday}`);
    await open_card(page, wednesday, "Weekly sync");
    check("the card offers the discussion", await is_shown(page, ".calendar-card-chat"));
    await shot(page, "card");
    await page.click(".calendar-card-chat");
    await wait_for_chat(page, "Weekly sync");
    const stream_id = Number(/channel\/(\d+)-/.exec(page.url())![1]);
    check(
        "the chat replaces the calendar",
        !(await is_shown(page, "#calendar-view")) && page.url().endsWith("/topic/"),
        page.url(),
    );
    const subtitle = await text(page, ".conversation-header-subtitle");
    check(
        "the header names the group chat and its next occurrence",
        /^Group chat · 3 participants · \w{3} \d\d\/\d\d\/\d{4} 3:00 PM – 4:00 PM$/.test(subtitle),
        subtitle,
    );
    check(
        "the header shows the calendar icon and no people button",
        (await is_shown(page, ".conversation-header-channel-icon .zulip-icon-calendar")) &&
            !(await is_shown(page, ".message-view-header-buttons")),
    );
    check(
        "the chat is among the chats, not the channels",
        (await text(page, `.meeting-chat-list-item[data-stream-id="${stream_id}"]`)) ===
            "Weekly sync 0" &&
            (await page.$(
                `.meeting-chat-list-item[data-stream-id="${stream_id}"].active-sub-filter`,
            )) !== null &&
            (await page.$(`#stream_filters [data-stream-id="${stream_id}"]`)) === null,
        await text(page, `.meeting-chat-list-item[data-stream-id="${stream_id}"]`),
    );
    check(
        "the compose box is the chat's, without a recipient row",
        (await is_shown(page, "#compose.compose-for-view")) &&
            (await page.$eval("textarea#compose-textarea", (element) => element.placeholder)) ===
                "Message Weekly sync",
        await page.$eval("textarea#compose-textarea", (element) => element.placeholder),
    );
    check(
        "the people panel lists the chat as one conversation",
        (await text(page, "#buddy-list-users-matching-view-section-heading")).startsWith(
            "THIS CONVERSATION",
        ) && !(await is_shown(page, "#buddy-list-participants-container")),
        await text(page, "#buddy-list-users-matching-view-section-heading"),
    );

    await page.click("textarea#compose-textarea");
    await page.keyboard.type("Agenda for Wednesday");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".message-list.bubble-layout .message_content")].some(
            (element) => element.textContent.trim() === "Agenda for Wednesday",
        ),
    );
    check("messages are bubbles, as in a group chat", true);
    await shot(page, "chat-dark");

    // A message from Othello counts as unread among the chats.
    await page.goto(`${base_url}#feed`);
    await page.waitForSelector(".message-list.mixed-view", {visible: true});
    run_python(
        python_prelude +
            String.raw`
chat = CalendarEvent.objects.get(id=${event_id}).chat
check_send_stream_message(othello, get_client("test"), chat.name, "", "Room changed")
`,
    );
    await page.waitForFunction(
        (stream_id) =>
            document
                .querySelector(
                    `.meeting-chat-list-item[data-stream-id="${CSS.escape(String(stream_id))}"] .unread_count`,
                )
                ?.textContent.trim() === "1",
        {},
        stream_id,
    );
    check("the chat's unread message counts in its row", true);
    await page.waitForSelector(".meeting-chat-fragment-header", {visible: true});
    check(
        "a mixed view names it as a group chat",
        (await text(page, ".meeting-chat-fragment-header .message_label_clickable")) ===
            "Group chat > Weekly sync",
        await text(page, ".meeting-chat-fragment-header .message_label_clickable"),
    );
    await shot(page, "feed-dark");

    // Renaming the meeting renames the chat; those invited later join it.
    run_python(
        python_prelude +
            String.raw`
update_calendar_event(othello, ${event_id}, title="Weekly retro", required_attendees=[desdemona, iago])
`,
    );
    await page.waitForFunction(
        (stream_id) =>
            document
                .querySelector(
                    `.meeting-chat-list-item[data-stream-id="${CSS.escape(String(stream_id))}"] .conversation-partners-list`,
                )
                ?.textContent.trim() === "Weekly retro",
        {},
        stream_id,
    );
    check("the renamed meeting renames its row", true);
    const subscribers = run_python(
        python_prelude +
            String.raw`
chat = CalendarEvent.objects.get(id=${event_id}).chat
print("SUBSCRIBERS " + json.dumps(sorted(
    s.user_profile.delivery_email
    for s in Subscription.objects.filter(recipient=chat.recipient, active=True)
)))
`,
    ).split("SUBSCRIBERS ", 2)[1]!;
    check(
        "Iago joined, Hamlet stayed",
        JSON.stringify(JSON.parse(subscribers)) ===
            JSON.stringify([
                "desdemona@zulip.com",
                "hamlet@zulip.com",
                "iago@zulip.com",
                "othello@zulip.com",
            ]),
        subscribers.trim(),
    );

    // The channel settings do not list the chat.
    await page.goto(`${base_url}#channels/subscribed`);
    await page.waitForSelector(".stream-row", {visible: true});
    check(
        "the channel settings leave it out",
        (await page.$(`.stream-row[data-stream-id="${stream_id}"]`)) === null,
    );

    // Leaving the chat takes it off the list.
    await page.goto(`${base_url}#feed`);
    await page.waitForSelector(".message-list.mixed-view", {visible: true});
    await page.hover(`.meeting-chat-list-item[data-stream-id="${stream_id}"]`);
    await page.click(
        `.meeting-chat-list-item[data-stream-id="${stream_id}"] .meeting-chat-sidebar-menu-icon`,
    );
    await page.waitForSelector(".meeting-chat-popover-leave", {visible: true});
    await shot(page, "leave-menu");
    await page.click(".meeting-chat-popover-leave");
    await page.waitForSelector("#leave_meeting_chat_modal", {visible: true});
    await page.click("#leave_meeting_chat_modal .dialog_submit_button");
    await page.waitForSelector(`.meeting-chat-list-item[data-stream-id="${stream_id}"]`, {
        hidden: true,
    });
    check("leaving the chat takes it off the list", true);

    // "Discussion" in the opened meeting opens the same chat.
    await open_week(page, `#calendar/workweek/${monday}`);
    await open_card(page, wednesday, "Weekly retro");
    await page.click(".calendar-card-expand");
    await page.waitForSelector(".calendar-meeting", {visible: true});
    await page.click(".calendar-meeting-chat");
    await wait_for_chat(page, "Weekly retro");
    check(
        "the opened meeting leads back to the same chat",
        Number(/channel\/(\d+)-/.exec(page.url())![1]) === stream_id &&
            (await page.$(`.meeting-chat-list-item[data-stream-id="${stream_id}"]`)) !== null,
        page.url(),
    );

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await page.reload();
    await wait_for_chat(page, "Weekly retro");
    check(
        "the header is in Russian",
        (await text(page, ".conversation-header-subtitle")).startsWith(
            "Групповой чат · 4 участника",
        ),
        await text(page, ".conversation-header-subtitle"),
    );
    await shot(page, "chat-light-ru");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_chat_test);
