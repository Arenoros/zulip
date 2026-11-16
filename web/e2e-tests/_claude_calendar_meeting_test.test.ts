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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-meeting";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Desdemona is invited to Othello's weekly meeting on Wednesdays, which
// her colleagues answered differently, and organizes a meeting on
// Tuesday that Hamlet forwarded to Cordelia.
const seed_script = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import (
    add_calendar_attendees,
    create_calendar_event,
    respond_to_calendar_event,
)
from zerver.models.calendar import CalendarResponse
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)


desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
cordelia = user("cordelia@zulip.com")
hamlet = user("hamlet@zulip.com")
iago = user("iago@zulip.com")
MOSCOW = ZoneInfo("Europe/Moscow")
today = datetime.now(MOSCOW).date()
monday = today - timedelta(days=today.weekday())


def at(day, hour):
    date = monday + timedelta(days=day)
    return datetime(date.year, date.month, date.day, hour, tzinfo=MOSCOW)


do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
weekly_id = create_calendar_event(
    othello,
    title="Weekly sync",
    start=at(2, 15),
    end=at(2, 16),
    event_timezone="Europe/Moscow",
    description="**Agenda**",
    location="Room 7",
    has_zulip_call=True,
    required_attendees=[desdemona, hamlet, iago],
    optional_attendees=[cordelia],
    rrule="FREQ=WEEKLY",
)
respond_to_calendar_event(cordelia, weekly_id, CalendarResponse.ACCEPTED)
respond_to_calendar_event(iago, weekly_id, CalendarResponse.DECLINED)
respond_to_calendar_event(
    hamlet, weekly_id, CalendarResponse.TENTATIVE, original_start=at(2, 15)
)
planning_id = create_calendar_event(
    desdemona,
    title="Planning",
    start=at(1, 11),
    end=at(1, 12),
    event_timezone="Europe/Moscow",
    required_attendees=[othello, hamlet],
    optional_attendees=[],
)
add_calendar_attendees(hamlet, planning_id, [cordelia], False)
print("SEEDED " + json.dumps({"monday": monday.isoformat()}))
`;

type Seeded = {monday: string};

type CalendarEvent = {
    id: number;
    title: string;
    start: number;
    show_as: number;
    reminder_minutes: number | null;
};

async function request(page: Page, method: string, url: string, body: string): Promise<unknown> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const [status, data] = await page.evaluate(
        async (method, url, body) => {
            const csrf_token =
                document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                    ?.value ?? "";
            const response = await fetch(method === "GET" ? `${url}?${body}` : url, {
                method,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": csrf_token,
                },
                body: method === "GET" ? null : body,
            });
            return [response.status, (await response.json()) as unknown] as const;
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

function moscow_seconds(date: string, hour: number): number {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!, hour - 3) / 1000;
}

function add_days(date: string, days: number): string {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

async function week_events(page: Page, monday: string): Promise<CalendarEvent[]> {
    const data = (await request(
        page,
        "GET",
        "/json/calendar/events",
        `start=${moscow_seconds(monday, 0)}&end=${moscow_seconds(add_days(monday, 7), 0)}`,
    )) as {events: CalendarEvent[]};
    return data.events;
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function open_week(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.reload();
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-day-column", {
        visible: true,
    });
}

async function is_shown(page: Page, selector: string): Promise<boolean> {
    return await page.$eval(selector, (element) => element.getClientRects().length > 0);
}

async function text(page: Page, selector: string): Promise<string> {
    return await page.$eval(selector, (element) =>
        element.textContent.trim().replaceAll(/\s+/g, " "),
    );
}

async function texts(page: Page, selector: string): Promise<string[]> {
    return await page.$$eval(selector, (elements) =>
        elements.map((element) => element.textContent.trim().replaceAll(/\s+/g, " ")),
    );
}

async function choose(page: Page, label: string): Promise<void> {
    await page.waitForSelector(".calendar-card-choices, .calendar-submenu", {visible: true});
    await page.evaluate((label) => {
        const options = [
            ...document.querySelectorAll<HTMLElement>(
                ".calendar-card-choice, .calendar-submenu-option",
            ),
        ];
        options.find((option) => option.textContent.trim() === label)!.click();
    }, label);
}

async function wait_for_meeting(page: Page): Promise<void> {
    await page.waitForSelector(".calendar-meeting", {visible: true});
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
}

async function open_meeting(page: Page, date: string, title: string): Promise<void> {
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
    await page.click(
        `.calendar-day-column[data-date="${date}"] .calendar-event[aria-label^="${title},"]`,
    );
    await page.waitForSelector(".calendar-card", {visible: true});
    await page.click(".calendar-card-expand");
}

async function calendar_meeting_test(page: Page): Promise<void> {
    const {monday} = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;
    const tuesday = add_days(monday, 1);
    const wednesday = add_days(monday, 2);
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    const week_hash = `#calendar/workweek/${monday}`;
    await open_week(page, week_hash);

    // An invitation opened on the whole window.
    await open_meeting(page, wednesday, "Weekly sync");
    await wait_for_meeting(page);
    check(
        "the meeting replaces the grid",
        !(await is_shown(page, ".calendar-grid-container")) &&
            (await text(page, ".calendar-meeting-title")) === "Weekly sync",
    );
    check(
        "the meeting shows its attendees, time and place",
        (await text(page, ".calendar-meeting-attendees")) ===
            "Othello, the Moor of Venice; Desdemona; 3 more" &&
            (await text(page, ".calendar-meeting-time")).endsWith("3:00 PM – 4:00 PM") &&
            (await text(page, ".calendar-meeting-location")) === "Room 7",
        await text(page, ".calendar-meeting-attendees"),
    );
    check(
        "the description and the Zulip call are below",
        (await text(page, ".calendar-meeting-description-text strong")) === "Agenda" &&
            (await text(page, ".calendar-meeting-call-time")) ===
                "Repeats every Wednesday, 3:00 PM – 4:00 PM (UTC+03:00)",
        await text(page, ".calendar-meeting-call-time"),
    );
    check(
        "the organizer and when they sent it",
        (
            await texts(page, ".calendar-responses-section:first-child .calendar-responses-name")
        )[0] === "Othello, the Moor of Venice" &&
            (
                await text(
                    page,
                    ".calendar-responses-section:first-child .calendar-responses-detail",
                )
            ).startsWith("Sent "),
    );
    check(
        "responses are by group, with this occurrence's",
        JSON.stringify(await texts(page, ".calendar-responses-group-toggle")) ===
            JSON.stringify(["Accepted: 1", "Tentative: 1", "Declined: 1", "Not answered: 1"]) &&
            (await text(page, ".calendar-responses-own")) === "You haven't responded" &&
            JSON.stringify(
                await texts(
                    page,
                    '.calendar-responses-group[data-response="accepted"] .calendar-responses-detail',
                ),
            ) === JSON.stringify(["Optional attendee"]),
        JSON.stringify(await texts(page, ".calendar-responses-group-toggle")),
    );
    await page.click(
        '.calendar-responses-group[data-response="accepted"] .calendar-responses-group-toggle',
    );
    check(
        "a group folds",
        !(await is_shown(
            page,
            '.calendar-responses-group[data-response="accepted"] .calendar-responses-people',
        )),
    );
    await page.click(".calendar-responses-hide");
    check("the responses panel hides", !(await is_shown(page, ".calendar-responses")));
    await page.click(".calendar-meeting-responses-button");
    check("the responses panel shows again", await is_shown(page, ".calendar-responses"));
    await shot(page, "dark-invitee");

    // Answering this occurrence, and the user's own settings.
    await page.click('.calendar-meeting-respond[data-response="accepted"]');
    await choose(page, "This occurrence");
    await page.waitForFunction(
        () =>
            document.querySelector(".calendar-responses-own")?.textContent.trim() ===
            "You accepted",
        {polling: 100},
    );
    check(
        "accepting this occurrence",
        (await page.$eval('.calendar-meeting-respond[data-response="accepted"]', (button) =>
            button.getAttribute("aria-pressed"),
        )) === "true" &&
            (await texts(page, ".calendar-responses-group-toggle"))[0] === "Accepted: 2",
    );
    await page.click('.calendar-meeting-menu-button[data-menu="show_as"]');
    await choose(page, "Free");
    await page.waitForFunction(
        () =>
            document
                .querySelector('.calendar-meeting-menu-button[data-menu="show_as"]')
                ?.textContent.trim() === "Free",
        {polling: 100},
    );
    await page.click('.calendar-meeting-menu-button[data-menu="reminder"]');
    await choose(page, "1 hour before");
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
    const weekly = (await week_events(page, monday)).find((event) => event.title === "Weekly sync");
    check(
        "show as and the reminder are the user's own",
        weekly?.show_as === 1 && weekly.reminder_minutes === 60,
        JSON.stringify(weekly),
    );

    // Forwarding.
    await page.click(".calendar-meeting-forward-button");
    await page.waitForSelector(".calendar-meeting-forward", {visible: true});
    await page.click(".calendar-meeting-forward-people .input");
    await page.keyboard.type("aaron");
    await page.waitForSelector(".typeahead.dropdown-menu .active", {visible: true});
    await page.keyboard.press("Enter");
    await page.click(".calendar-meeting-forward-send");
    await page.waitForFunction(
        () => document.querySelector(".calendar-meeting-attendees")?.textContent.includes("4 more"),
        {polling: 100},
    );
    check("forwarding adds an attendee", true);

    // Other occurrences and the series.
    await page.click(".calendar-meeting-occurrences");
    await page.waitForSelector(".calendar-card-choices", {visible: true});
    const occurrences = await texts(page, ".calendar-card-choice");
    check(
        "all occurrences lists the next ones",
        occurrences.length >= 2 &&
            occurrences.every((label) => label.endsWith("3:00 PM – 4:00 PM")),
        JSON.stringify(occurrences),
    );
    const current_time = await text(page, ".calendar-meeting-time");
    const next = occurrences.find((label) => label !== current_time)!;
    await choose(page, next);
    await page.waitForFunction(
        (next) => document.querySelector(".calendar-meeting-time")?.textContent.trim() === next,
        {polling: 100},
        next,
    );
    check("an occurrence opens from the list", true);
    await page.click(".calendar-meeting-series");
    await page.waitForFunction(
        () =>
            document
                .querySelector(".calendar-meeting-time")
                ?.textContent.trim()
                .startsWith("Repeats every Wednesday"),
        {polling: 100},
    );
    check("the whole series opens", !(await page.$(".calendar-meeting-series")));

    // Copying the series into a new event.
    await page.click(".calendar-meeting-copy");
    await page.waitForSelector(".calendar-form", {visible: true});
    check(
        "copying opens a new event with the fields but no attendees",
        (await page.$eval(".calendar-form-title", (input) => (input as HTMLInputElement).value)) ===
            "Weekly sync" &&
            (await page.$$(".calendar-form-required-attendees .pill")).length === 0 &&
            (await text(page, ".calendar-form-time-summary")).startsWith(
                "Repeats every Wednesday",
            ) &&
            !(await page.$(".calendar-meeting")),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector(".calendar-form", {hidden: true});

    // Escape closes the meeting.
    await open_meeting(page, wednesday, "Weekly sync");
    await wait_for_meeting(page);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".calendar-meeting", {hidden: true});
    check("Escape closes the meeting", await is_shown(page, ".calendar-grid-container"));

    // Removing this occurrence from the user's calendar.
    await open_meeting(page, wednesday, "Weekly sync");
    await wait_for_meeting(page);
    await page.click(".calendar-meeting-delete");
    await choose(page, "This occurrence");
    await common.wait_for_micromodal_to_open(page);
    await page.click(".micromodal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForSelector(".calendar-meeting", {hidden: true});
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
    check(
        "deleting this occurrence closes the meeting and removes it",
        !(await week_events(page, monday)).some((event) => event.title === "Weekly sync"),
    );

    // The organizer changes their meeting, next to the responses.
    await open_meeting(page, tuesday, "Planning");
    await page.waitForSelector(".calendar-form", {visible: true});
    await page.waitForSelector(".calendar-responses", {visible: true});
    check(
        "the organizer sees the form with the responses and who forwarded",
        !(await is_shown(page, ".calendar-form-day")) &&
            (await texts(page, ".calendar-responses-detail")).some((detail) =>
                detail.includes("Added by King Hamlet"),
            ),
        JSON.stringify(await texts(page, ".calendar-responses-detail")),
    );
    await page.click(".calendar-form-responses-button");
    check(
        "the organizer can switch back to the day",
        (await is_shown(page, ".calendar-form-day")) &&
            !(await is_shown(page, ".calendar-responses")),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector(".calendar-form", {hidden: true});

    // Light theme, in Russian, and a narrow window.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await open_week(page, `#calendar/workweek/${add_days(monday, 7)}`);
    await open_meeting(page, add_days(wednesday, 7), "Weekly sync");
    await wait_for_meeting(page);
    check(
        "the meeting is in Russian",
        (await text(page, ".calendar-meeting-call-time")).startsWith("Повторяется каждую среду") &&
            (await texts(page, ".calendar-responses-heading"))[0] === "Организатор",
        await text(page, ".calendar-meeting-call-time"),
    );
    await shot(page, "light-ru-invitee");
    await page.setViewport({width: 480, height: 900});
    const layout = await page.$eval(".calendar-meeting", (element) => ({
        scroll_width: element.scrollWidth,
        client_width: element.clientWidth,
    }));
    check(
        "at 480px the meeting fits the window",
        layout.scroll_width <= layout.client_width,
        JSON.stringify(layout),
    );
    await shot(page, "light-ru-480");
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_meeting_test);
