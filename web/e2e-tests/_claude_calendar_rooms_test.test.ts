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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-rooms";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.message_flags import do_mark_all_as_read
from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event
from zerver.lib.calendar.rooms import create_calendar_room, update_calendar_room
from zerver.models import CalendarEvent, CalendarEventRoom, CalendarRoom
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

// Hamlet booked the Blue room next Wednesday at 13:00 in Moscow, when
// Desdemona plans a review with Othello.
const seed_script =
    python_prelude +
    String.raw`
for email in ["desdemona@zulip.com", "othello@zulip.com", "hamlet@zulip.com"]:
    do_change_user_setting(user(email), "timezone", "Europe/Moscow", acting_user=None)
blue_id = create_calendar_room(realm, name="Blue room", capacity=8, location="Floor 2", email="blue-room@zulip.com")
create_calendar_room(realm, name="Attic", capacity=4, location="", email="")
old_id = create_calendar_room(realm, name="Old room", capacity=None, location="", email="")
update_calendar_room(CalendarRoom.objects.get(id=old_id), is_archived=True)
today = datetime.now(MOSCOW).date()
wednesday = today - timedelta(days=today.weekday()) + timedelta(days=9)
start = datetime(wednesday.year, wednesday.month, wednesday.day, 13, tzinfo=MOSCOW)
create_calendar_event(
    hamlet,
    title="Board meeting",
    start=start,
    end=start + timedelta(hours=1),
    event_timezone="Europe/Moscow",
    required_attendees=[],
    optional_attendees=[],
    room_ids=[blue_id],
)
event_id = create_calendar_event(
    desdemona,
    title="Review",
    start=start,
    end=start + timedelta(minutes=30),
    event_timezone="Europe/Moscow",
    required_attendees=[othello],
    optional_attendees=[],
)
do_mark_all_as_read(desdemona)
print("SEEDED " + json.dumps({"event_id": event_id, "start": int(start.timestamp()), "wednesday": wednesday.isoformat()}))
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

async function texts(page: Page, selector: string): Promise<string[]> {
    return await page.$$eval(selector, (elements) =>
        elements.map((element) => element.textContent.trim().replaceAll(/\s+/g, " ")),
    );
}

async function room_rows(page: Page): Promise<string[]> {
    return await texts(page, "#admin_meeting_rooms_table .meeting_room_row");
}

async function wait_for_room_rows(page: Page, count: number): Promise<void> {
    await page.waitForFunction(
        (count) =>
            document.querySelectorAll("#admin_meeting_rooms_table .meeting_room_row").length ===
            count,
        {},
        count,
    );
}

// The JSON that a script printed after the marker.
function get_printed(output: string, marker: string): unknown {
    return JSON.parse(output.slice(output.indexOf(marker) + marker.length));
}

function get_saved_rooms(event_id: number): {rooms: string[]; location: string} {
    const output = run_python(
        python_prelude +
            String.raw`
event = CalendarEvent.objects.get(id=${event_id})
rooms = sorted(CalendarEventRoom.objects.filter(event=event).values_list("room__name", flat=True))
print("SAVED " + json.dumps({"rooms": rooms, "location": event.location}))
`,
    );
    return z
        .object({rooms: z.array(z.string()), location: z.string()})
        .parse(get_printed(output, "SAVED "));
}

// The form takes the focus once it opens.
async function wait_for_room_form(page: Page): Promise<void> {
    await page.waitForFunction(() => document.activeElement?.id === "meeting-room-name");
    await new Promise((resolve) => setTimeout(resolve, 300));
}

async function add_room(page: Page, selector: string, query: string): Promise<void> {
    await page.click(`${selector} .input`);
    await page.keyboard.type(query);
    await page.waitForSelector(".typeahead.dropdown-menu .active", {visible: true});
    await page.keyboard.press("Enter");
}

// The calendar replaces the link with the week's once it opens the
// event, so the page is not reloaded after it.
async function open_form(page: Page, event_id: number, start: number): Promise<void> {
    await page.goto(`${base_url}#calendar/event/${event_id}/${start}`);
    await page.waitForSelector(".calendar-form-location .input", {visible: true});
}

async function calendar_rooms_test(page: Page): Promise<void> {
    const {event_id, start, wednesday} = z
        .object({event_id: z.number(), start: z.number(), wednesday: z.string()})
        .parse(get_printed(run_python(seed_script), "SEEDED "));
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // An administrator manages the rooms in the organization settings.
    await page.goto(`${base_url}#organization/meeting-rooms`);
    await page.waitForSelector("#meeting-rooms", {visible: true});
    await wait_for_room_rows(page, 3);
    const rows = await room_rows(page);
    check(
        "the settings list the rooms, with the archived one marked",
        rows[0]!.startsWith("Attic 4") &&
            rows[1]!.startsWith("Blue room 8 Floor 2 blue-room@zulip.com") &&
            rows[2]!.startsWith("Old room Archived"),
        JSON.stringify(rows),
    );
    await page.click("#add-meeting-room-button");
    await wait_for_room_form(page);
    await page.type("#meeting-room-name", "Den");
    await page.type("#meeting-room-capacity", "6");
    await page.type("#meeting-room-location", "Floor 3");
    await shot(page, "add-dark");
    await page.click("#meeting-room-modal .dialog_submit_button");
    await page.waitForSelector("#meeting-room-modal", {hidden: true});
    await wait_for_room_rows(page, 4);
    check(
        "an administrator adds a room",
        (await room_rows(page)).some((row) => row.startsWith("Den 6 Floor 3")),
    );
    await page.click(".meeting_room_row:has(.meeting_room_name) .edit-meeting-room");
    await wait_for_room_form(page);
    await page.evaluate(() => {
        document.querySelector<HTMLInputElement>("#meeting-room-capacity")!.value = "5";
    });
    await page.click("#meeting-room-modal .dialog_submit_button");
    await page.waitForSelector("#meeting-room-modal", {hidden: true});
    await page.waitForFunction(
        () =>
            document.querySelector("#admin_meeting_rooms_table .meeting_room_capacity")
                ?.textContent === "5",
    );
    check("an administrator changes a room", (await room_rows(page))[0]!.startsWith("Attic 5"));
    const den_row = await page.$$eval("#admin_meeting_rooms_table .meeting_room_row", (rows) =>
        rows.findIndex((row) => row.textContent.includes("Den")),
    );
    await page.click(
        `#admin_meeting_rooms_table .meeting_room_row:nth-child(${den_row + 1}) .archive-meeting-room`,
    );
    await page.waitForSelector(".archived_meeting_room_row .meeting_room_name");
    await page.waitForFunction(
        () => document.querySelectorAll(".archived_meeting_room_row").length === 2,
    );
    check("an administrator archives a room", true);
    await shot(page, "settings-dark");

    // The organizer books a room that is taken, and another that is free.
    await open_form(page, event_id, start);
    await page.click(".calendar-form-location .input");
    await page.keyboard.type("room");
    await page.waitForSelector(".typeahead.dropdown-menu .active", {visible: true});
    const suggestions = await texts(page, ".typeahead.dropdown-menu li");
    check(
        "the place suggests the rooms that can be booked",
        suggestions.length === 1 && suggestions[0] === "Blue room 8 seats · Floor 2",
        JSON.stringify(suggestions),
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector(".calendar-form-location .pill");
    await page.keyboard.type("by the window");
    await shot(page, "form-dark");
    await page.click(".calendar-form-save");
    await page.waitForSelector(".calendar-form-error.shown", {visible: true});
    const error = (await texts(page, ".calendar-form-error"))[0]!;
    check(
        "a room that is booked declines the meeting",
        error.includes(`Blue room is booked for another meeting at ${wednesday} 13:00.`),
        error,
    );
    await page.click(".calendar-form-location .pill .exit");
    await page.waitForSelector(".calendar-form-location .pill", {hidden: true});
    await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>(".calendar-form-location .input")!;
        input.textContent = "";
    });
    await add_room(page, ".calendar-form-location", "att");
    await page.waitForSelector(".calendar-form-location .pill");
    await page.keyboard.type("by the window");
    await page.click(".calendar-form-save");
    await page.waitForSelector(".calendar-form", {hidden: true});
    const saved = get_saved_rooms(event_id);
    check(
        "a room that is free accepts the meeting, and the text stays its place",
        JSON.stringify(saved) === JSON.stringify({rooms: ["Attic"], location: "by the window"}),
        JSON.stringify(saved),
    );

    // The card shows the rooms with the place.
    await page.goto(`${base_url}#calendar/workweek/${wednesday}`);
    await page.reload();
    const review = `.calendar-day-column[data-date="${wednesday}"] .calendar-event[aria-label^="Review,"]`;
    await page.waitForSelector(review, {visible: true});
    await page.click(review);
    await page.waitForSelector(".calendar-card", {visible: true});
    const location = (await texts(page, ".calendar-card-location"))[0];
    check("the card shows the rooms and the place", location === "Attic; by the window", location);
    await page.keyboard.press("Escape");

    // The scheduler shows when rooms are booked.
    await open_form(page, event_id, start);
    await page.click(".calendar-form-scheduler");
    await page.waitForSelector(".calendar-scheduler-room-label", {visible: true});
    // The scheduler draws again once it has the free/busy times.
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
    await add_room(page, '.calendar-scheduler-add[data-section="rooms"]', "blue");
    await page.waitForFunction(
        () => document.querySelectorAll(".calendar-scheduler-room-label").length === 2,
    );
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
    let rooms = await texts(page, ".calendar-scheduler-room-label");
    check(
        "the scheduler shows the rooms, and that a booked one is unavailable",
        rooms[0] === "Attic 5 seats" &&
            rooms[1] === "Blue room Unavailable 8 seats · Floor 2" &&
            (await page.$$eval(
                ".calendar-scheduler-room-track",
                (tracks) => tracks[1]!.querySelectorAll(".calendar-scheduler-block").length,
            )) === 1,
        JSON.stringify(rooms),
    );
    await shot(page, "scheduler-dark");
    await page.click(".calendar-scheduler-find");
    await page.waitForFunction(
        () =>
            document
                .querySelector<HTMLSelectElement>(".calendar-scheduler-start")
                ?.selectedOptions[0]?.textContent.trim() !== "1:00 PM",
    );
    rooms = await texts(page, ".calendar-scheduler-room-label");
    const time = await page.evaluate(() =>
        document
            .querySelector<HTMLSelectElement>(".calendar-scheduler-start")!
            .selectedOptions[0]!.textContent.trim(),
    );
    check(
        "Find a time finds a time when the rooms are free",
        time === "2:00 PM" && !rooms[1]!.includes("Unavailable"),
        `${time} ${JSON.stringify(rooms)}`,
    );
    await page.click(".calendar-scheduler-back");
    await page.waitForSelector(".calendar-form-save", {visible: true});
    const pills = await texts(page, ".calendar-form-location .pill");
    check(
        "the rooms added in the scheduler are in the form",
        JSON.stringify(pills) === JSON.stringify(["Attic", "Blue room"]),
        JSON.stringify(pills),
    );

    // In Russian, and in the light theme.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await page.goto(`${base_url}#organization/meeting-rooms`);
    await page.reload();
    await page.waitForSelector("#meeting-rooms", {visible: true});
    await wait_for_room_rows(page, 4);
    const sidebar = await texts(page, '.sidebar-item[data-section="meeting-rooms"] .text');
    check("the settings are in Russian", sidebar[0] === "Переговорные", JSON.stringify(sidebar));
    await shot(page, "settings-light-ru");
    await open_form(page, event_id, start);
    await page.click(".calendar-form-scheduler");
    await page.waitForSelector(".calendar-scheduler-room-label", {visible: true});
    const sections = await texts(page, ".calendar-scheduler-section-toggle");
    check(
        "the scheduler's rooms are in Russian",
        sections[2] === "Переговорные" &&
            (await texts(page, ".calendar-scheduler-room-label"))[0] === "Attic 5 мест",
        JSON.stringify(sections),
    );
    await shot(page, "scheduler-light-ru");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_rooms_test);
