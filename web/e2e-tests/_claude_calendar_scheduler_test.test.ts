import {execSync} from "node:child_process";

import type {Page} from "puppeteer";
import * as z from "zod/mini";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-scheduler";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.message_flags import do_mark_all_as_read
from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event
from zerver.models import CalendarEvent
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

// Desdemona plans a review next Wednesday at 13:00 in Moscow with
// Othello, who works in Tokyo, and Hamlet, who is busy then.
const seed_script =
    python_prelude +
    String.raw`
do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
do_change_user_setting(othello, "timezone", "Asia/Tokyo", acting_user=None)
today = datetime.now(MOSCOW).date()
wednesday = today - timedelta(days=today.weekday()) + timedelta(days=9)
start = datetime(wednesday.year, wednesday.month, wednesday.day, 13, tzinfo=MOSCOW)
event_id = create_calendar_event(
    desdemona,
    title="Review",
    start=start,
    end=start + timedelta(minutes=30),
    event_timezone="Europe/Moscow",
    required_attendees=[othello],
    optional_attendees=[hamlet],
)
create_calendar_event(
    hamlet,
    title="Dentist",
    start=start,
    end=start + timedelta(hours=1),
    event_timezone="Europe/Moscow",
    required_attendees=[],
    optional_attendees=[],
)
do_mark_all_as_read(desdemona)
print("SEEDED " + json.dumps({"event_id": event_id, "start": int(start.timestamp()), "wednesday": wednesday.isoformat()}))
`;

const seeded_schema = z.object({event_id: z.number(), start: z.number(), wednesday: z.string()});

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

async function texts(page: Page, selector: string): Promise<string[]> {
    return await page.$$eval(selector, (elements) =>
        elements.map((element) => element.textContent.trim().replaceAll(/\s+/g, " ")),
    );
}

async function selected_time(page: Page): Promise<string> {
    return await page.$eval(".calendar-scheduler-start", (element) => {
        if (!(element instanceof HTMLSelectElement)) {
            throw new TypeError("Expected <select>");
        }
        return element.selectedOptions[0]!.textContent.trim();
    });
}

async function wait_for_loaded(page: Page): Promise<void> {
    await page.waitForSelector(".calendar-scheduler-person-label", {visible: true});
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
}

function add_days(date: string, days: number): string {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

async function calendar_scheduler_test(page: Page): Promise<void> {
    const {event_id, start, wednesday} = seeded_schema.parse(
        JSON.parse(run_python(seed_script).split("SEEDED ", 2)[1]!),
    );
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // The organizer opens the meeting, and its scheduler.
    await page.goto(`${base_url}#calendar/event/${event_id}/${start}`);
    await page.waitForSelector(".calendar-form-scheduler", {visible: true});
    await page.click(".calendar-form-scheduler");
    await wait_for_loaded(page);
    const people = await texts(page, ".calendar-scheduler-person-label");
    check(
        "the scheduler lists the organizer and the attendees",
        people.length === 3 &&
            people[0]!.startsWith("Desdemona") &&
            people[1]!.startsWith("Othello, the Moor of Venice Unavailable") &&
            people[1]!.includes("UTC+09:00") &&
            people[2]!.startsWith("King Hamlet Unavailable"),
        JSON.stringify(people),
    );
    check(
        "Othello's row shows his local time, outside of his work hours",
        people[1]!.includes("7:00 PM") &&
            (await page.$$(".calendar-scheduler-person-track")).length === 3,
        people[1],
    );
    check(
        "Hamlet's busy time shows in his row",
        (await page.$$eval(
            ".calendar-scheduler-person-track",
            (tracks) => tracks[2]!.querySelectorAll(".calendar-scheduler-block.busy").length,
        )) === 1,
    );
    await shot(page, "dark");

    // "Find a time" finds when everyone required works and is free.
    await page.click(".calendar-scheduler-find");
    await page.waitForFunction(
        (date) =>
            document.querySelector(".calendar-scheduler-day.selected")?.textContent.includes(date),
        {},
        String(Number(add_days(wednesday, 1).slice(8))),
    );
    check(
        "Find a time picks Thursday at 9:00 AM",
        (await selected_time(page)) === "9:00 AM",
        await selected_time(page),
    );

    // Dragging the selection two hours later moves the meeting.
    const box = (await (await page.$(".calendar-scheduler-selection"))!.boundingBox())!;
    const hour_width = await page.$eval(
        ".calendar-scheduler-hour",
        (element) => element.getBoundingClientRect().width,
    );
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + hour_width, box.y + 40, {steps: 5});
    await page.mouse.move(box.x + box.width / 2 + 2 * hour_width, box.y + 40, {steps: 5});
    await page.mouse.up();
    await page.waitForFunction(
        () =>
            document
                .querySelector<HTMLSelectElement>(".calendar-scheduler-start")
                ?.selectedOptions[0]?.textContent.trim() === "11:00 AM",
    );
    check("dragging the selection moves the meeting", true);

    // The options show the whole day, at another scale.
    await page.click(".calendar-scheduler-options");
    await page.waitForSelector("#calendar-scheduler-options-menu", {visible: true});
    await shot(page, "options-dark");
    await page.click(".calendar-scheduler-work-hours-option");
    await page.waitForFunction(
        () =>
            document
                .querySelector(".calendar-scheduler-day")
                ?.querySelectorAll(".calendar-scheduler-hour").length === 24,
    );
    check("the whole day can be shown", true);
    await page.click(".calendar-scheduler-options");
    await page.waitForSelector("#calendar-scheduler-options-menu", {visible: true});
    await page.click('.calendar-scheduler-scale-option[data-scale="60"]');
    await page.waitForSelector("#calendar-scheduler-options-menu", {hidden: true});
    check("the scale can change", true);

    // Back to the form, which has the new time, and saving.
    await page.click(".calendar-scheduler-back");
    await page.waitForSelector(".calendar-form-save", {visible: true});
    await page.click(".calendar-form-time-summary");
    const form_start = await page.$eval(".calendar-form-start", (element) => {
        if (!(element instanceof HTMLSelectElement)) {
            throw new TypeError("Expected <select>");
        }
        return element.selectedOptions[0]!.textContent.trim();
    });
    check("the form has the time chosen in the scheduler", form_start === "11:00 AM", form_start);
    await page.click(".calendar-form-scheduler");
    await wait_for_loaded(page);
    await page.click(".calendar-scheduler-save");
    await page.waitForSelector(".calendar-form", {hidden: true});
    const saved = run_python(
        python_prelude +
            String.raw`
event = CalendarEvent.objects.get(id=${event_id})
print("SAVED " + event.start.astimezone(MOSCOW).isoformat())
`,
    )
        .split("SAVED ", 2)[1]!
        .trim();
    check(
        "saving from the scheduler saves the meeting",
        saved === `${add_days(wednesday, 1)}T11:00:00+03:00`,
        saved,
    );

    // In Russian, and in the light theme.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    // The language applies after a reload. The link is opened after
    // it, since the calendar replaces the link with the week's.
    await page.reload();
    await page.waitForSelector("#calendar-view", {visible: true});
    await page.goto(`${base_url}#calendar/event/${event_id}/${start + 86_400 - 7200}`);
    await page.waitForSelector(".calendar-form-scheduler", {visible: true});
    await page.click(".calendar-form-scheduler");
    await wait_for_loaded(page);
    const labels = await texts(page, ".calendar-scheduler-section-toggle");
    check(
        "the scheduler is in Russian",
        labels[0] === "Обязательные участники" &&
            (await texts(page, ".calendar-scheduler-find"))[0] === "Подобрать время",
        JSON.stringify(labels),
    );
    await shot(page, "light-ru");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_scheduler_test);
