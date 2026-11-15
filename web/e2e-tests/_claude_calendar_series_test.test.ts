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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-series";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Desdemona's week in Moscow: Othello is busy every Thursday morning,
// and she organizes a daily series with a changed occurrence on
// Tuesday.
const seed_script = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event, update_calendar_event
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
MOSCOW = ZoneInfo("Europe/Moscow")
today = datetime.now(MOSCOW).date()
monday = today - timedelta(days=today.weekday())


def at(day, hour):
    date = monday + timedelta(days=day)
    return datetime(date.year, date.month, date.day, hour, tzinfo=MOSCOW)


do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
create_calendar_event(
    othello,
    title="Othello's planning",
    start=at(3, 9),
    end=at(3, 10),
    event_timezone="Europe/Moscow",
    required_attendees=[],
    optional_attendees=[],
    rrule="FREQ=WEEKLY",
)
daily_id = create_calendar_event(
    desdemona,
    title="Daily sync",
    start=at(0, 16),
    end=at(0, 17),
    event_timezone="Europe/Moscow",
    required_attendees=[othello],
    optional_attendees=[],
    rrule="FREQ=DAILY",
)
update_calendar_event(desdemona, daily_id, original_start=at(1, 16), title="Daily sync (moved)")
print(
    "SEEDED "
    + json.dumps({"monday": monday.isoformat(), "daily_id": daily_id})
)
`;

type Seeded = {monday: string; daily_id: number};

type CalendarEvent = {
    id: number;
    title: string;
    start: number;
    timezone: string;
    rrule: string;
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

function moscow_seconds(date: string, hour: number, minute = 0): number {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!, hour - 3, minute) / 1000;
}

function add_days(date: string, days: number): string {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

// As in "Thu 11/12/2026".
function date_label(date: string): string {
    const [year, month, day] = date.split("-");
    const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: "UTC",
    });
    return `${weekday} ${month}/${day}/${year}`;
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

async function is_shown(page: Page, selector: string): Promise<boolean> {
    return await page.$eval(selector, (element) => element.getClientRects().length > 0);
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

async function wait_for_grid(page: Page): Promise<void> {
    await page.waitForSelector(".calendar-form", {hidden: true});
    await page.waitForSelector(".calendar-grid:not(.loading)", {visible: true});
    // The grid draws again for the server's event about the change.
    await page.waitForNetworkIdle({idleTime: 500, concurrency: 1});
}

async function summary(page: Page): Promise<string> {
    return await page.$eval(".calendar-form-time-summary", (button) => button.textContent.trim());
}

async function wait_for_summary(page: Page, text: string): Promise<void> {
    await page
        .waitForFunction(
            (text) =>
                document.querySelector(".calendar-form-time-summary")?.textContent.trim() ===
                text,
            {polling: 100, timeout: 5000},
            text,
        )
        .catch(() => undefined);
}

async function suggestions(page: Page): Promise<{time: string; free: string; selected: boolean}[]> {
    await page.waitForSelector(".calendar-form-suggestion", {visible: true});
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
    return await page.$$eval(".calendar-form-suggestion", (buttons) =>
        buttons.map((button) => ({
            time: button.querySelector(".calendar-form-suggestion-time")!.textContent.trim(),
            free: button.querySelector(".calendar-form-suggestion-free")!.textContent.trim(),
            selected: button.classList.contains("selected"),
        })),
    );
}

async function click_empty_time(page: Page, date: string, hour: number): Promise<void> {
    await page.evaluate(
        (date, hour) => {
            const container = document.querySelector(".calendar-grid-container")!;
            const column = document.querySelector(`.calendar-day-column[data-date="${date}"]`)!;
            container.scrollTop = (column.getBoundingClientRect().height / 24) * (hour - 1);
        },
        date,
        hour,
    );
    const box = (await (await page.$(`.calendar-day-column[data-date="${date}"]`))!.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + (box.height / 24) * (hour + 0.2));
    await page.waitForSelector(".calendar-form", {visible: true});
}

async function calendar_series_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;
    const {monday} = seeded;
    const thursday = add_days(monday, 3);
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    const week_hash = `#calendar/workweek/${monday}`;
    await open_week(page, week_hash);

    // A new weekly meeting on Thursday at 10:00.
    await click_empty_time(page, thursday, 10);
    check(
        "the time row starts folded",
        !(await is_shown(page, ".calendar-form-time-panel")) &&
            !(await is_shown(page, ".calendar-form-suggestions")),
    );
    await page.type(".calendar-form-title", "Weekly review");
    await page.click(".calendar-form-required-attendees .input");
    await page.keyboard.type("Othello");
    await page.waitForSelector(".typeahead.dropdown-menu .active", {visible: true});
    await page.keyboard.press("Enter");
    await page.click(".calendar-form-series-button");
    await page.waitForSelector(".calendar-form-recurrence", {visible: true});
    let expected = `Repeats every Thursday, from 10:00 AM to 10:30 AM, starting ${date_label(thursday)}`;
    await wait_for_summary(page, expected);
    check(
        "Series repeats the event weekly on its day",
        (await summary(page)) === expected &&
            (await page.$eval(".calendar-form-series-button", (button) =>
                button.classList.contains("selected"),
            )) &&
            !(await page.$eval(".calendar-form-event-button", (button) =>
                button.classList.contains("selected"),
            )),
        await summary(page),
    );

    // Othello is busy on Thursdays from 9:00 to 10:00.
    let times = await suggestions(page);
    check(
        "suggested times are those when everyone is free, near the chosen one",
        JSON.stringify(times.map((time) => time.time)) ===
            JSON.stringify([
                "10:00 AM – 10:30 AM (30 min)",
                "10:30 AM – 11:00 AM (30 min)",
                "11:00 AM – 11:30 AM (30 min)",
                "11:30 AM – 12:00 PM (30 min)",
                "12:00 PM – 12:30 PM (30 min)",
            ]) &&
            times.every((time) => time.free === "100% free") &&
            times[0]!.selected,
        JSON.stringify(times),
    );

    await page.click('.calendar-form-weekday[data-weekday="MO"]');
    await page.select(".calendar-form-interval", "2");
    expected = `Repeats every 2 weeks on Mon and Thu, from 10:00 AM to 10:30 AM, starting ${date_label(thursday)}`;
    await wait_for_summary(page, expected);
    check("days and the interval change the series", (await summary(page)) === expected, await summary(page));

    // The last day, and back to forever.
    const last_day = add_days(thursday, 7);
    await page.click(".calendar-form-until");
    await page.waitForSelector(".calendar-date-picker-popover", {visible: true});
    await page.click(`.calendar-date-picker-popover .calendar-mini-month-day[data-date="${last_day}"]`);
    expected = `Repeats every 2 weeks on Mon and Thu, from 10:00 AM to 10:30 AM, from ${date_label(thursday)} until ${date_label(last_day)}`;
    await wait_for_summary(page, expected);
    check("the series can end on a day", (await summary(page)) === expected, await summary(page));
    await page.click(".calendar-form-until-remove");
    check(
        "the trash button makes the series repeat forever",
        (await summary(page)).endsWith(`starting ${date_label(thursday)}`) &&
            (await page.$eval(".calendar-form-until", (button) => button.textContent.trim())) ===
                "No end date",
    );

    // Picking a suggested time.
    times = await suggestions(page);
    await page.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLElement>(".calendar-form-suggestion")];
        buttons.find((button) => button.textContent.includes("11:00 AM – 11:30 AM"))!.click();
    });
    expected = `Repeats every 2 weeks on Mon and Thu, from 11:00 AM to 11:30 AM, starting ${date_label(thursday)}`;
    await wait_for_summary(page, expected);
    check("a suggested time sets the time", (await summary(page)) === expected, await summary(page));
    await shot(page, "dark-new");

    await page.click(".calendar-form-save");
    await wait_for_grid(page);
    const review = (await week_events(page, monday)).find(
        (event) => event.title === "Weekly review",
    );
    const saved = review === undefined
        ? undefined
        : ((await request(page, "GET", `/json/calendar/events/${review.id}`, "")) as {
              event: CalendarEvent;
          }).event;
    check(
        "the series is saved with its rule",
        saved !== undefined &&
            saved.rrule === "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH" &&
            saved.start === moscow_seconds(thursday, 11) &&
            saved.timezone === "Europe/Moscow",
        JSON.stringify(saved),
    );

    // Changing the whole series from its changed occurrence.
    const tuesday = add_days(monday, 1);
    await page.click(
        `.calendar-day-column[data-date="${tuesday}"] .calendar-event[aria-label^="Daily sync (moved),"]`,
    );
    await page.waitForSelector(".calendar-card", {visible: true});
    await page.click(".calendar-card-edit");
    await page.waitForSelector(".calendar-card-choices", {visible: true});
    await page.evaluate(() => {
        const choices = [...document.querySelectorAll<HTMLElement>(".calendar-card-choice")];
        choices.find((choice) => choice.textContent.trim() === "The whole series")!.click();
    });
    await page.waitForSelector(".calendar-form", {visible: true});
    check(
        "the whole series opens with the series' title and start",
        (await page.$eval(".calendar-form-title", (input) => (input as HTMLInputElement).value)) ===
            "Daily sync" &&
            (await summary(page)) ===
                `Repeats every day, from 4:00 PM to 5:00 PM, starting ${date_label(monday)}`,
        await summary(page),
    );
    await page.click(".calendar-form-time-summary");
    await page.select(".calendar-form-start", String(17 * 60));
    await page.click(".calendar-form-save");
    await common.wait_for_micromodal_to_open(page);
    check(
        "changing when a series with changed occurrences takes place asks first",
        (await page.$eval(".micromodal .modal__title", (title) => title.textContent.trim())) ===
            "Change the whole series?",
    );
    await page.click(".micromodal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await wait_for_grid(page);
    const daily = (await week_events(page, monday)).filter((event) =>
        event.title.startsWith("Daily sync"),
    );
    check(
        "the series moves, without its changed occurrence",
        daily.length === 7 &&
            daily.every(
                (event, index) =>
                    event.title === "Daily sync" &&
                    event.start === moscow_seconds(add_days(monday, index), 17),
            ),
        JSON.stringify(daily.map((event) => [event.title, event.start])),
    );

    // An event in another timezone.
    await page.click(".calendar-new-event-button");
    await page.waitForSelector(".calendar-form", {visible: true});
    await page.type(".calendar-form-title", "Tokyo call");
    await page.click(".calendar-form-time-summary");
    const start_minute = Number(await page.$eval(".calendar-form-start", (select) => (select as HTMLSelectElement).value));
    await page.click(".calendar-form-timezone");
    await page.waitForSelector(".dropdown-list-search-input", {visible: true});
    await page.type(".dropdown-list-search-input", "Asia/Tokyo");
    const tokyo = await page.waitForSelector(
        `xpath///*[${common.has_class_x("list-item")}][starts-with(normalize-space(), "Asia/Tokyo")]`,
        {visible: true},
    );
    await tokyo!.click();
    await page.waitForFunction(
        () => document.querySelector(".calendar-form-time-summary")!.textContent.includes("(Asia/Tokyo)"),
        {polling: 100},
    );
    check("the summary names another timezone", true);
    await page.click(".calendar-form-event-button");
    check(
        "Event makes the event not repeat",
        !(await summary(page)).startsWith("Repeats") &&
            !(await is_shown(page, ".calendar-form-recurrence")),
    );
    await page.click(".calendar-form-save");
    await wait_for_grid(page);
    const data = (await request(
        page,
        "GET",
        "/json/calendar/events",
        // From the day before, where the event falls in Moscow if it
        // was created soon after midnight there.
        `start=${moscow_seconds(add_days(monday, -1), 0)}&end=${moscow_seconds(add_days(monday, 60), 0)}`,
    )) as {events: CalendarEvent[]};
    const call = data.events.find((event) => event.title === "Tokyo call");
    const tokyo_time = call === undefined
        ? undefined
        : new Intl.DateTimeFormat("en-US", {
              hour: "numeric",
              minute: "numeric",
              hourCycle: "h23",
              timeZone: "Asia/Tokyo",
          }).format(new Date(call.start * 1000));
    const expected_time = `${String(Math.floor(start_minute / 60)).padStart(2, "0")}:${String(start_minute % 60).padStart(2, "0")}`;
    check(
        "the event keeps its time of day in its timezone",
        call !== undefined && call.timezone === "Asia/Tokyo" && call.rrule === "" && tokyo_time === expected_time,
        JSON.stringify({call, tokyo_time, expected_time}),
    );

    // Light theme, in Russian, and a narrow window.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await open_week(page, week_hash);
    await click_empty_time(page, thursday, 10);
    await page.click(".calendar-form-required-attendees .input");
    await page.keyboard.type("Othello");
    await page.waitForSelector(".typeahead.dropdown-menu .active", {visible: true});
    await page.keyboard.press("Enter");
    await page.click(".calendar-form-series-button");
    await page.click('.calendar-form-weekday[data-weekday="MO"]');
    await page.waitForSelector(".calendar-form-suggestion", {visible: true});
    check(
        "the summary is in Russian",
        (await summary(page)).startsWith("Повторяется каждую неделю по пн и чт"),
        await summary(page),
    );
    await shot(page, "light-ru-new");
    await page.setViewport({width: 480, height: 900});
    const layout = await page.$eval(".calendar-form", (form) => ({
        scroll_width: form.scrollWidth,
        client_width: form.clientWidth,
    }));
    check(
        "at 480px the series editor fits the window",
        layout.scroll_width <= layout.client_width,
        JSON.stringify(layout),
    );
    await page.evaluate(() => {
        document.querySelector(".calendar-form-time-panel")!.scrollIntoView();
    });
    await shot(page, "light-ru-480");
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_series_test);
