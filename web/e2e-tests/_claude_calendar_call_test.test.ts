import {execSync} from "node:child_process";

import type {Browser, Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-call";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.actions.video_calls import do_end_livekit_call
from zerver.lib.calendar.changes import create_calendar_event
from zerver.models import CalendarAttendee, CalendarEvent, LiveKitCall
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

// Othello organizes a weekly meeting with a Zulip call on Wednesdays,
// and a meeting without one on Thursday, with Desdemona and Hamlet.
const seed_script =
    python_prelude +
    String.raw`
today = datetime.now(MOSCOW).date()
monday = today - timedelta(days=today.weekday())
do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)


def create(title, day, **kwargs):
    date = monday + timedelta(days=day)
    return create_calendar_event(
        othello,
        title=title,
        start=datetime(date.year, date.month, date.day, 15, tzinfo=MOSCOW),
        end=datetime(date.year, date.month, date.day, 16, tzinfo=MOSCOW),
        event_timezone="Europe/Moscow",
        required_attendees=[desdemona, hamlet],
        optional_attendees=[],
        **kwargs,
    )


event_id = create("Design review", 2, rrule="FREQ=WEEKLY", has_zulip_call=True)
create("Lunch", 3)
print("SEEDED " + json.dumps({
    "monday": monday.isoformat(),
    "event_id": event_id,
    "meet_code": CalendarEvent.objects.get(id=event_id).meet_code,
}))
`;

type Seeded = {monday: string; event_id: number; meet_code: string};

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
    // After a call's page, the network may not settle, so this waits
    // for the meetings instead.
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-event", {
        visible: true,
    });
}

async function open_card(page: Page, date: string, title: string): Promise<void> {
    await page.click(
        `.calendar-day-column[data-date="${date}"] .calendar-event[aria-label^="${title},"]`,
    );
    await page.waitForSelector(".calendar-card", {visible: true});
}

// Clicks something that joins a call, and returns the address and
// title of the call's window.
async function join_call(
    browser: Browser,
    page: Page,
    selector: string,
): Promise<{url: string; title: string}> {
    const target_promise = browser.waitForTarget((target) =>
        target.url().includes("/calls/livekit/join"),
    );
    await page.click(selector);
    const target = await target_promise;
    const call_page = await target.page();
    let title = "";
    if (call_page !== null) {
        await call_page.waitForFunction(() => document.title !== "");
        title = await call_page.title();
        await call_page.close();
    }
    return {url: new URL(target.url()).pathname + new URL(target.url()).search, title};
}

function get_calls(event_id: number): {urls: string[]; chat_id: number} {
    return JSON.parse(
        run_python(
            python_prelude +
                String.raw`
chat = CalendarEvent.objects.get(id=${event_id}).chat
print("CALLS " + json.dumps({
    "urls": [call.url for call in LiveKitCall.objects.filter(message__recipient=chat.recipient).order_by("id")],
    "chat_id": chat.id,
}))
`,
        ).split("CALLS ")[1]!,
    ) as {urls: string[]; chat_id: number};
}

function end_calls(): void {
    run_python(
        python_prelude +
            String.raw`
for call in LiveKitCall.objects.filter(date_ended=None):
    do_end_livekit_call(call.room)
`,
    );
}

async function calendar_call_test(page: Page): Promise<void> {
    const {monday, event_id, meet_code} = JSON.parse(
        run_python(seed_script).split("SEEDED ")[1]!,
    ) as Seeded;
    const wednesday = add_days(monday, 2);
    const thursday = add_days(monday, 3);
    const browser = page.browser();
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/realm", "video_chat_provider=10");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // "Join" in the card starts the call in the meeting's chat.
    await open_week(page, `#calendar/workweek/${monday}`);
    check("the toolbar offers to meet now", await is_shown(page, ".calendar-meet-now-button"));
    await open_card(page, thursday, "Lunch");
    check(
        "a meeting without a Zulip call cannot be joined",
        !(await is_shown(page, ".calendar-card .calendar-join-button")),
    );
    await page.keyboard.press("Escape");
    await open_card(page, wednesday, "Design review");
    check(
        "a meeting with a Zulip call can be joined",
        (await text(page, ".calendar-card .calendar-join-button")) === "Join",
    );
    await shot(page, "card-dark");
    const first = await join_call(browser, page, ".calendar-card .calendar-join-button");
    const {urls, chat_id} = get_calls(event_id);
    check(
        "joining starts the call in the meeting's chat",
        urls.length === 1 && first.url === urls[0] && first.url.includes(`channel_id=${chat_id}`),
        `${first.url} ${JSON.stringify(urls)}`,
    );
    check("the call's window is named after the meeting", first.title === "Design review | Zulip", first.title);

    // Joining again, without video, joins the same call.
    await page.click(".calendar-card .calendar-join-options-button");
    await page.waitForSelector(".calendar-card-choice", {visible: true});
    await shot(page, "join-menu");
    const voice = await join_call(browser, page, ".calendar-card-choice");
    check(
        "joining without video joins the same call",
        voice.url === `${first.url}&voice_only=true` && get_calls(event_id).urls.length === 1,
        voice.url,
    );
    await page.keyboard.press("Escape");

    // The opened meeting joins the call, and links to it.
    await open_card(page, wednesday, "Design review");
    await page.click(".calendar-card-expand");
    await page.waitForSelector(".calendar-meeting", {visible: true});
    check(
        "the opened meeting links to its call",
        (await page.$eval(".calendar-meeting-call-link", (element) =>
            element.getAttribute("href"),
        )) === `/meet/${meet_code}`,
    );
    await shot(page, "meeting-dark");
    const from_meeting = await join_call(browser, page, ".calendar-meeting .calendar-join-button");
    const from_link = await join_call(browser, page, ".calendar-meeting-call-link");
    check(
        "the opened meeting joins the same call",
        from_meeting.url === first.url && from_link.url === first.url,
        `${from_meeting.url} ${from_link.url}`,
    );

    // The header of the meeting's chat joins it too.
    await page.goto(`${base_url}#narrow/channel/${chat_id}-chat/topic/`);
    await page.waitForSelector(".message-view-header-join-meeting-call", {visible: true});
    await shot(page, "chat-dark");
    const from_chat = await join_call(browser, page, ".message-view-header-join-meeting-call");
    check("the chat's header joins the same call", from_chat.url === first.url, from_chat.url);

    // The meeting's link joins the call while it takes place, and
    // otherwise offers to start it.
    await page.goto(`${base_url}meet/${meet_code}`);
    check(
        "the meeting's link joins the call taking place",
        page.url().endsWith(first.url),
        page.url(),
    );
    end_calls();
    await page.goto(`${base_url}meet/${meet_code}`);
    await page.waitForSelector(".calendar-meet-start-button", {visible: true});
    check(
        "after the call ends, the link offers to start another",
        (await text(page, "h1")) === "Design review",
        await text(page, "h1"),
    );
    await shot(page, "meet-start-dark");
    await Promise.all([page.waitForNavigation(), page.click(".calendar-meet-start-button")]);
    const second_urls = get_calls(event_id).urls;
    check(
        "starting it from the link starts a new call",
        second_urls.length === 2 && page.url().endsWith(second_urls[1]!),
        page.url(),
    );

    // "Meet now" makes a meeting from now with the people chosen, and
    // joins its call.
    await open_week(page, `#calendar/workweek/${monday}`);
    await page.click(".calendar-meet-now-button");
    await page.waitForSelector("#calendar-meet-now-modal", {visible: true});
    check(
        "meet now is titled by default",
        (await page.$eval("#calendar-meet-now-title", (element) => (element as HTMLInputElement).value)) ===
            "Meet now",
    );
    await page.type("#calendar-meet-now-modal .calendar-meet-now-attendees .input", "Othello");
    await page.waitForSelector(".typeahead .active", {visible: true});
    await page.keyboard.press("Enter");
    await page.waitForSelector("#calendar-meet-now-modal .pill", {visible: true});
    await shot(page, "meet-now-dark");
    const meet_now = await join_call(browser, page, "#calendar-meet-now-modal .dialog_submit_button");
    const meet_now_event = JSON.parse(
        run_python(
            python_prelude +
                String.raw`
event = CalendarEvent.objects.filter(title="Meet now").latest("id")
print("MEETNOW " + json.dumps({
    "minutes": int((event.end - event.start).total_seconds() // 60),
    "has_zulip_call": event.has_zulip_call,
    "attendees": sorted(a.user.delivery_email for a in CalendarAttendee.objects.filter(event=event)),
    "chat_id": event.chat_id,
}))
`,
        ).split("MEETNOW ")[1]!,
    ) as {minutes: number; has_zulip_call: boolean; attendees: string[]; chat_id: number};
    check(
        "meet now makes a 30 minute meeting with a Zulip call and joins it",
        meet_now_event.minutes === 30 &&
            meet_now_event.has_zulip_call &&
            JSON.stringify(meet_now_event.attendees) ===
                JSON.stringify(["desdemona@zulip.com", "othello@zulip.com"]) &&
            meet_now.url.includes(`channel_id=${meet_now_event.chat_id}`),
        `${JSON.stringify(meet_now_event)} ${meet_now.url}`,
    );
    await page.waitForSelector("#calendar-meet-now-modal", {hidden: true});

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await open_week(page, `#calendar/workweek/${monday}`);
    await open_card(page, wednesday, "Design review");
    check(
        "the buttons are in Russian",
        (await text(page, ".calendar-card .calendar-join-button")) === "Подключиться" &&
            (await text(page, ".calendar-meet-now-button")) === "Звонок сейчас",
        `${await text(page, ".calendar-card .calendar-join-button")} / ${await text(page, ".calendar-meet-now-button")}`,
    );
    await shot(page, "card-light-ru");
    await page.keyboard.press("Escape");
    await page.click(".calendar-meet-now-button");
    await page.waitForSelector("#calendar-meet-now-modal", {visible: true});
    await shot(page, "meet-now-light-ru");
    await page.keyboard.press("Escape");
    end_calls();
    await page.goto(`${base_url}meet/${meet_code}`);
    await page.waitForSelector(".calendar-meet-start-button", {visible: true});
    check(
        "the meeting's link is in Russian",
        (await text(page, ".calendar-meet-start-button")) === "Начать звонок",
        await text(page, ".calendar-meet-start-button"),
    );
    await shot(page, "meet-start-light-ru");
    await page.goto(base_url);
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");
    await request(page, "PATCH", "/json/realm", "video_chat_provider=1");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_call_test);
