import {execSync} from "node:child_process";

import type {HTTPRequest, Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-grid";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import (
    cancel_calendar_event,
    create_calendar_event,
    respond_to_calendar_event,
    update_calendar_attendee_settings,
)
from zerver.models.calendar import CalendarResponse, CalendarShowAs
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
MOSCOW = ZoneInfo("Europe/Moscow")
today = datetime.now(MOSCOW).date()
monday = today - timedelta(days=today.weekday())


def at(day, hour, minute=0):
    date = monday + timedelta(days=day)
    return datetime(date.year, date.month, date.day, hour, minute, tzinfo=MOSCOW)


def event(organizer, title, start, end, attendees=(), **kwargs):
    return create_calendar_event(
        organizer,
        title=title,
        start=start,
        end=end,
        event_timezone="Europe/Moscow",
        required_attendees=list(attendees),
        optional_attendees=[],
        **kwargs,
    )
`;

// Desdemona's week in Moscow, Monday being day 0.
const seed_script =
    python_prelude +
    String.raw`
do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
event(othello, "Planning", at(0, 10), at(0, 11), [desdemona])
event(othello, "Review", at(0, 10, 30), at(0, 11, 30), [desdemona])
event(desdemona, "Focus time", at(1, 9), at(1, 9, 30))
cancelled = event(othello, "Release", at(1, 14), at(1, 15), [desdemona])
cancel_calendar_event(othello, cancelled, None)
tentative = event(othello, "Interview", at(2, 13), at(2, 14), [desdemona])
respond_to_calendar_event(desdemona, tentative, CalendarResponse.TENTATIVE, None)
webinar = event(othello, "Webinar", at(2, 15), at(2, 16), [desdemona])
update_calendar_attendee_settings(desdemona, webinar, show_as=CalendarShowAs.FREE)
update_calendar_attendee_settings(desdemona, webinar, category="Green category")
event(desdemona, "Conference", at(3, 0), at(4, 0), is_all_day=True)
event(othello, "Night release", at(3, 22), at(4, 2), [desdemona])
event(desdemona, "Lunch", at(0, 12), at(0, 12, 30), rrule="FREQ=DAILY")
print("SEEDED " + json.dumps({"monday": monday.isoformat(), "today": today.isoformat()}))
`;

const live_script =
    python_prelude +
    String.raw`
event(othello, "Live meeting", at(4, 16), at(4, 17), [desdemona])
print("CREATED")
`;

type Seeded = {
    monday: string;
    today: string;
};

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

async function open_week(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.reload();
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-day-column", {
        visible: true,
    });
    await page.waitForFunction(
        () => document.querySelectorAll(".calendar-grid .calendar-event").length > 0,
        {polling: 100},
    );
}

type EventFacts = {
    title: string;
    day: string | undefined;
    class_name: string;
    label: string;
    left: number;
    width: number;
    column_width: number;
};

async function event_facts(page: Page): Promise<EventFacts[]> {
    return await page.$$eval(".calendar-grid .calendar-event", (events) =>
        events.map((event) => {
            const column = event.closest(".calendar-day-column");
            const rect = event.getBoundingClientRect();
            return {
                title: event.querySelector(".calendar-event-title")!.textContent.trim(),
                day: column?.getAttribute("data-date") ?? undefined,
                class_name: event.className,
                label: event.getAttribute("aria-label") ?? "",
                left: rect.left - (column?.getBoundingClientRect().left ?? 0),
                width: rect.width,
                column_width: column?.getBoundingClientRect().width ?? 0,
            };
        }),
    );
}

function add_days(date: string, days: number): string {
    const [year, month, day] = date.split("-").map(Number);
    const result = new Date(Date.UTC(year!, month! - 1, day! + days));
    return result.toISOString().slice(0, 10);
}

async function calendar_grid_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;

    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // The work week.
    await open_week(page, `#calendar/workweek/${seeded.monday}`);
    let events = await event_facts(page);
    const by_title = (title: string): EventFacts[] => events.filter((e) => e.title === title);
    const days = await page.$$eval(".calendar-day-column", (columns) =>
        columns.map((column) => column.getAttribute("data-date")),
    );
    check(
        "the work week shows Monday to Friday",
        days.length === 5 && days[0] === seeded.monday && days[4] === add_days(seeded.monday, 4),
        JSON.stringify(days),
    );

    const planning = by_title("Planning")[0]!;
    const review = by_title("Review")[0]!;
    check(
        "overlapping events share the width of their day",
        Math.abs(planning.width - review.width) < 1 &&
            planning.width < planning.column_width / 2 &&
            review.left > planning.left + planning.width - 1,
        JSON.stringify([planning.left, planning.width, review.left, review.width]),
    );
    check(
        "the label of an event gives its time and organizer",
        planning.label === "Planning, 10:00 AM – 11:00 AM, Othello, the Moor of Venice",
        planning.label,
    );
    check(
        "an event without other attendees is personal",
        by_title("Focus time")[0]?.class_name.includes("personal") === true,
    );
    check(
        "a canceled event says so",
        by_title("Canceled: Release")[0]?.class_name.includes("cancelled") === true,
    );
    check(
        "a tentative event is marked",
        by_title("Interview")[0]?.class_name.includes("tentative") === true &&
            by_title("Interview")[0]!.label.endsWith("Tentative"),
    );
    check(
        "an event shown as free is marked",
        by_title("Webinar")[0]?.class_name.includes("free") === true,
    );
    const webinar_bar = await page.$$eval(
        ".calendar-grid .calendar-event.free",
        (elements) => getComputedStyle(elements[0]!).borderLeftColor,
    );
    check("a category colors the bar", webinar_bar === "rgb(19, 161, 14)", webinar_bar);
    const lunches = by_title("Lunch");
    check(
        "a series shows every day with its icon",
        lunches.length === 5 &&
            lunches.every((lunch) => lunch.class_name.includes("recurring")) &&
            (await page.$$(".calendar-event-series-icon")).length === 5,
    );
    check(
        "an event over midnight shows on both days",
        JSON.stringify(by_title("Night release").map((e) => e.day)) ===
            JSON.stringify([add_days(seeded.monday, 3), add_days(seeded.monday, 4)]),
    );
    const conference = await page.evaluate(
        (thursday) => {
            const bar = document.querySelector(".calendar-all-day-event")!;
            const bar_rect = bar.getBoundingClientRect();
            const column = document
                .querySelector(`.calendar-day-column[data-date="${thursday}"]`)!
                .getBoundingClientRect();
            return {
                title: bar.textContent.trim(),
                // The bar spans its day, inside its small margins.
                left_inset: bar_rect.left - column.left,
                right_inset: column.right - bar_rect.right,
                above_hours: bar.closest(".calendar-grid-top") !== null,
            };
        },
        add_days(seeded.monday, 3),
    );
    check(
        "an all-day event is above the hours, on its day",
        conference.title === "Conference" &&
            conference.left_inset >= 0 &&
            conference.left_inset < 6 &&
            conference.right_inset >= 0 &&
            conference.right_inset < 6 &&
            conference.above_hours,
        JSON.stringify(conference),
    );
    // The hour right under the day headers, which stay at the top.
    const scroll = await page.evaluate(() => {
        const top = document.querySelector(".calendar-grid-top")!.getBoundingClientRect();
        const column = document.querySelector(".calendar-day-column")!.getBoundingClientRect();
        return ((top.bottom - column.top) / column.height) * 24;
    });
    check("the grid opens at the start of the work day", Math.abs(scroll - 8.5) < 0.1, `${scroll}`);
    await shot(page, "dark-work-week");

    // Tab moves through the events.
    await page.focus(".calendar-next-week");
    let focused_event = false;
    for (let i = 0; i < 20 && !focused_event; i += 1) {
        await page.keyboard.press("Tab");
        focused_event = await page.evaluate(
            () => document.activeElement?.classList.contains("calendar-event") ?? false,
        );
    }
    check("Tab reaches the events", focused_event);

    // The week, with today and the current time.
    await open_week(page, `#calendar/week/${seeded.monday}`);
    const today = await page.evaluate(() => ({
        header: document.querySelector(".calendar-day-header.today")?.textContent.trim(),
        column: document.querySelector(".calendar-day-column.today")?.getAttribute("data-date"),
        line: document.querySelector<HTMLElement>(".calendar-now-line")?.style.top,
    }));
    check(
        "today is marked, with the current time",
        today.column === seeded.today && today.line !== undefined && today.line !== "",
        JSON.stringify(today),
    );
    await shot(page, "dark-week");

    // A new event shows without reloading.
    run_python(live_script);
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".calendar-event-title")].some(
                (title) => title.textContent.trim() === "Live meeting",
            ),
        {polling: 200, timeout: 10_000},
    );
    check("a new event shows without reloading", true);

    // A week that cannot be loaded is not shown as free.
    const fail_events = (intercepted: HTTPRequest): void => {
        if (intercepted.url().includes("/json/calendar/events")) {
            void intercepted.respond({status: 500, body: "{}"});
        } else {
            void intercepted.continue();
        }
    };
    await page.setRequestInterception(true);
    page.on("request", fail_events);
    await page.click(".calendar-next-week");
    await page.waitForSelector(".calendar-grid-error", {visible: true});
    check(
        "a failed load shows an error with a retry button",
        (await page.$(".calendar-grid.load-failed")) !== null &&
            (await page.$(".calendar-grid-error .calendar-grid-retry")) !== null,
    );
    await shot(page, "dark-load-failed");
    page.off("request", fail_events);
    await page.setRequestInterception(false);
    await page.click(".calendar-grid-retry");
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-event", {visible: true});
    check(
        "retrying loads the week",
        (await page.$(".calendar-grid.load-failed")) === null &&
            (await page.$$(".calendar-grid .calendar-event")).length > 0,
    );

    // 24-hour time, a larger time scale and the light theme.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&twenty_four_hour_time=true");
    await request(page, "PATCH", "/json/calendar/settings", "time_scale_minutes=60");
    await open_week(page, `#calendar/workweek/${seeded.monday}`);
    events = await event_facts(page);
    check(
        "times follow the 24-hour setting",
        by_title("Planning")[0]?.label.includes("10:00 – 11:00") === true,
        by_title("Planning")[0]?.label,
    );
    const hour_height = await page.evaluate(
        () => document.querySelector(".calendar-day-column")!.getBoundingClientRect().height / 24,
    );
    check(
        "an hour is one row at the 60-minute scale",
        Math.abs(hour_height - 42) < 1,
        `${hour_height}`,
    );
    await shot(page, "light-60-minutes");
    await request(page, "PATCH", "/json/calendar/settings", "time_scale_minutes=30");
    await request(page, "PATCH", "/json/settings", "color_scheme=1&twenty_four_hour_time=false");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_grid_test);
