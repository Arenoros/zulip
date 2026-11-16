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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-form";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Desdemona's week in Moscow, with a meeting on Wednesday morning and a
// daily series she organizes.
const seed_script = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event
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
    title="Existing",
    start=at(2, 9),
    end=at(2, 10),
    event_timezone="Europe/Moscow",
    required_attendees=[desdemona],
    optional_attendees=[],
)
create_calendar_event(
    desdemona,
    title="Daily sync",
    start=at(0, 16),
    end=at(0, 17),
    event_timezone="Europe/Moscow",
    required_attendees=[othello],
    optional_attendees=[],
    rrule="FREQ=DAILY",
)
print(
    "SEEDED "
    + json.dumps(
        {"monday": monday.isoformat(), "othello": othello.id, "desdemona": desdemona.id}
    )
)
`;

type Seeded = {monday: string; othello: number; desdemona: number};

type Occurrence = {
    id: number;
    title: string;
    start: number;
    end: number;
    location: string;
    has_zulip_call: boolean;
    show_as: number;
    is_private: boolean;
    allow_forwarding: boolean;
    reminder_minutes: number | null;
    category: string;
    description: string;
    original_start: number | null;
    attendees: {user_id: number; is_required: boolean}[];
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

async function week_events(page: Page, monday: string): Promise<Occurrence[]> {
    const data = (await request(
        page,
        "GET",
        "/json/calendar/events",
        `start=${moscow_seconds(monday, 0)}&end=${moscow_seconds(add_days(monday, 7), 0)}`,
    )) as {events: Occurrence[]};
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

async function wait_for_form(page: Page): Promise<void> {
    await page.waitForSelector(".calendar-form", {visible: true});
}

async function wait_for_grid(page: Page): Promise<void> {
    await page.waitForSelector(".calendar-form", {hidden: true});
    await page.waitForSelector(".calendar-grid:not(.loading)", {visible: true});
    // The grid draws again for the server's event about the change.
    await page.waitForNetworkIdle({idleTime: 500, concurrency: 1});
}

async function add_attendee(page: Page, selector: string, name: string): Promise<void> {
    await page.click(`${selector} .input`);
    await page.keyboard.type(name.split(",")[0]!);
    await page.waitForSelector(".typeahead.dropdown-menu .active", {visible: true});
    await page.keyboard.press("Enter");
    await page.waitForFunction(
        (selector, name) =>
            [...document.querySelectorAll(`${selector} .pill`)].some((pill) =>
                pill.textContent.includes(name),
            ),
        {polling: 100},
        selector,
        name,
    );
}

async function choose_menu(page: Page, menu: string, label: string): Promise<void> {
    await page.click(`.calendar-form-menu-button[data-menu="${menu}"]`);
    await page.waitForSelector(".calendar-submenu", {visible: true});
    await page.evaluate((label) => {
        const options = [...document.querySelectorAll<HTMLElement>(".calendar-submenu-option")];
        options.find((option) => option.textContent.trim() === label)!.click();
    }, label);
    await page.waitForSelector(".calendar-submenu", {hidden: true});
}

async function form_times(page: Page): Promise<{date: string; start: string; end: string}> {
    return await page.evaluate(() => {
        const text = (selector: string): string => {
            const select = document.querySelector<HTMLSelectElement>(selector)!;
            return select.selectedOptions[0]!.textContent.trim();
        };
        return {
            date: document.querySelector(".calendar-form-date")!.textContent.trim(),
            start: text(".calendar-form-start"),
            end: text(".calendar-form-end"),
        };
    });
}

async function calendar_form_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;
    const {monday} = seeded;
    const wednesday = add_days(monday, 2);
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    const week_hash = `#calendar/workweek/${monday}`;
    await open_week(page, week_hash);

    // A new meeting with every field.
    await page.click(".calendar-new-event-button");
    await wait_for_form(page);
    check(
        "the form opens with the title focused",
        (await page.evaluate(() =>
            document.activeElement?.classList.contains("calendar-form-title"),
        )) === true,
    );
    await page.type(".calendar-form-title", "Design review");
    await add_attendee(page, ".calendar-form-required-attendees", "Othello, the Moor of Venice");
    await page.click(".calendar-form-attendee-options");
    await page.waitForSelector(".calendar-form-attendee-options-menu", {visible: true});
    await page.click('.calendar-form-attendee-option[data-option="allow_forwarding"]');
    check(
        "optional attendees are hidden until added",
        !(await is_shown(page, ".calendar-form-optional-row")),
    );
    await page.click(".calendar-form-add-optional");
    await page.waitForSelector(".calendar-form-optional-row:not(.hide)", {visible: true});
    await add_attendee(page, ".calendar-form-optional-attendees", "Cordelia, Lear's daughter");

    // The time row unfolds into its fields.
    await page.click(".calendar-form-time-summary");
    await page.waitForSelector(".calendar-form-time-panel", {visible: true});
    await page.click(".calendar-form-date");
    await page.waitForSelector(".calendar-date-picker-popover", {visible: true});
    await page.click(
        `.calendar-date-picker-popover .calendar-mini-month-day[data-date="${wednesday}"]`,
    );
    await page.waitForSelector(".calendar-date-picker-popover", {hidden: true});
    await page.select(".calendar-form-start", String(10 * 60));
    let times = await form_times(page);
    check(
        "the end moves with the start",
        times.start === "10:00 AM" && times.end === "10:30 AM",
        JSON.stringify(times),
    );
    await page.select(".calendar-form-end", "60");
    await page.type(".calendar-form-location .input", "Room 5");
    await page.click(".calendar-form-call-checkbox");
    await page.type(".calendar-form-description-input", "Agenda");
    await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
            ".calendar-form-description-input",
        )!;
        textarea.setSelectionRange(0, textarea.value.length);
    });
    await page.click('.calendar-form-format[data-format-type="bold"]');
    check(
        "formatting buttons format the description",
        (await page.$eval(
            ".calendar-form-description-input",
            (element) => (element as HTMLTextAreaElement).value,
        )) === "**Agenda**",
    );
    await page.click(".calendar-form-preview");
    await page.waitForFunction(
        () => document.querySelector(".calendar-form-description-preview strong") !== null,
        {polling: 100},
    );
    check("the preview renders the description", true);
    await page.click(".calendar-form-preview");

    // Emoji go into the description, at its end.
    await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
            ".calendar-form-description-input",
        )!;
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    await page.click(".calendar-form-description .emoji_map");
    await page.waitForSelector(".emoji-picker-popover", {visible: true});
    await page.click('.emoji-picker-popover .emoji-popover-emoji[data-emoji-name="+1"]');
    await page.waitForSelector(".emoji-picker-popover", {hidden: true});
    check(
        "the emoji picker inserts into the description",
        (
            await page.$eval(
                ".calendar-form-description-input",
                (element) => (element as HTMLTextAreaElement).value,
            )
        ).includes(":+1:"),
    );

    await choose_menu(page, "show_as", "Tentative");
    await choose_menu(page, "reminder", "30 minutes before");
    await choose_menu(page, "category", "Red category");
    await choose_menu(page, "visibility", "Private");

    // Dragging the event on the day grid moves it by an hour.
    const day_events = await page.$$eval(
        ".calendar-form-day-column .calendar-event-title",
        (titles) => titles.map((title) => title.textContent.trim()),
    );
    check("the day grid shows the day's other events", day_events.includes("Existing"));
    const block = (await page.$(".calendar-form-day-block"))!;
    const box = (await block.boundingBox())!;
    const hour = await page.$eval(
        ".calendar-form-day-column",
        (column) => column.getBoundingClientRect().height / 24,
    );
    await page.mouse.move(box.x + box.width / 2, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 5 + hour / 2, {steps: 5});
    await page.mouse.move(box.x + box.width / 2, box.y + 5 + hour, {steps: 5});
    await page.mouse.up();
    times = await form_times(page);
    check(
        "dragging the event moves its time",
        times.start === "11:00 AM" && times.end === "12:00 PM",
        JSON.stringify(times),
    );
    await shot(page, "dark-new");

    // Saving twice creates one event.
    await page.evaluate(() => {
        const save = document.querySelector<HTMLElement>(".calendar-form-save")!;
        save.click();
        save.click();
    });
    await wait_for_grid(page);
    let events = (await week_events(page, monday)).filter(
        (event) => event.title === "Design review",
    );
    const saved = events[0];
    check(
        "saving twice creates one meeting with every field",
        events.length === 1 &&
            saved !== undefined &&
            saved.start === moscow_seconds(wednesday, 11) &&
            saved.end === moscow_seconds(wednesday, 12) &&
            saved.location === "Room 5" &&
            saved.has_zulip_call &&
            saved.show_as === 2 &&
            saved.is_private &&
            !saved.allow_forwarding &&
            saved.reminder_minutes === 30 &&
            saved.category === "Red category" &&
            saved.description === "**Agenda** :+1: " &&
            JSON.stringify(
                saved.attendees
                    .filter((attendee) => attendee.user_id !== seeded.desdemona)
                    .map((attendee) => attendee.is_required),
            ) === JSON.stringify([true, false]),
        JSON.stringify(saved),
    );

    // Changing it from its card.
    await page.click(
        `.calendar-day-column[data-date="${wednesday}"] .calendar-event[aria-label^="Design review,"]`,
    );
    await page.waitForSelector(".calendar-card", {visible: true});
    await page.click(".calendar-card-edit");
    await wait_for_form(page);
    check(
        "the form for a change has the meeting's data",
        (await page.$eval(".calendar-form-title", (input) => (input as HTMLInputElement).value)) ===
            "Design review" &&
            (await page.$$(".calendar-form-required-attendees .pill")).length === 1 &&
            (await page.$$(".calendar-form-optional-attendees .pill")).length === 1,
    );
    await page.$eval(".calendar-form-title", (input) => {
        (input as HTMLInputElement).value = "";
    });
    await page.type(".calendar-form-title", "Design review, moved");
    await page.click(".calendar-form-save");
    await wait_for_grid(page);
    events = await week_events(page, monday);
    check(
        "a change saves the new title",
        events.some((event) => event.title === "Design review, moved"),
    );

    // Changing one occurrence of a series.
    const tuesday = add_days(monday, 1);
    await page.click(
        `.calendar-day-column[data-date="${tuesday}"] .calendar-event[aria-label^="Daily sync,"]`,
    );
    await page.waitForSelector(".calendar-card", {visible: true});
    await page.click(".calendar-card-edit");
    await page.waitForSelector(".calendar-card-choices", {visible: true});
    await page.evaluate(() => {
        const choices = [...document.querySelectorAll<HTMLElement>(".calendar-card-choice")];
        choices.find((choice) => choice.textContent.trim() === "This occurrence")!.click();
    });
    await wait_for_form(page);
    check(
        "an occurrence keeps the settings of its series",
        (await page.$(".calendar-form-occurrence-note")) !== null &&
            (await page.$eval(
                ".calendar-form-call-checkbox",
                (input) => (input as HTMLInputElement).disabled,
            )),
    );
    await page.$eval(".calendar-form-title", (input) => {
        (input as HTMLInputElement).value = "";
    });
    await page.type(".calendar-form-title", "Daily sync (Tuesday)");
    await page.click(".calendar-form-save");
    await wait_for_grid(page);
    events = (await week_events(page, monday)).filter((event) =>
        event.title.startsWith("Daily sync"),
    );
    check(
        "changing an occurrence changes only that one",
        events.filter((event) => event.title === "Daily sync (Tuesday)").length === 1 &&
            events.filter((event) => event.title === "Daily sync").length === 6,
        JSON.stringify(events.map((event) => event.title)),
    );

    // An empty title is an error under the field.
    const thursday = add_days(monday, 3);
    const thursday_column = (await page.$(`.calendar-day-column[data-date="${thursday}"]`))!;
    const column_box = (await thursday_column.boundingBox())!;
    await page.evaluate((thursday) => {
        const container = document.querySelector(".calendar-grid-container")!;
        const column = document.querySelector(`.calendar-day-column[data-date="${thursday}"]`)!;
        container.scrollTop = (column.getBoundingClientRect().height / 24) * 13;
    }, thursday);
    const column_rect = await page.$eval(
        `.calendar-day-column[data-date="${thursday}"]`,
        (column) => {
            const rect = column.getBoundingClientRect();
            return {top: rect.top, height: rect.height};
        },
    );
    await page.mouse.click(
        column_box.x + column_box.width / 2,
        column_rect.top + (column_rect.height / 24) * 14.2,
    );
    await wait_for_form(page);
    times = await form_times(page);
    check(
        "clicking an empty time opens a half-hour event there",
        times.start === "2:00 PM" && times.end === "2:30 PM",
        JSON.stringify(times),
    );
    await page.click(".calendar-form-save");
    await page.waitForSelector(".calendar-form-title-error.shown", {visible: true});
    check("an empty title is an error under the field", true);

    // A draft stays when leaving the calendar.
    await page.type(".calendar-form-title", "Draft");
    await page.click("#calendar-navbar-button");
    await page.waitForFunction(() => !document.body.classList.contains("calendar-view-visible"));
    await page.click("#calendar-navbar-button");
    await wait_for_form(page);
    check(
        "a draft stays when leaving the calendar",
        (await page.$eval(".calendar-form-title", (input) => (input as HTMLInputElement).value)) ===
            "Draft",
    );

    // Canceling with changes asks first.
    await page.click(".calendar-form-cancel");
    await common.wait_for_micromodal_to_open(page);
    await page.click(".micromodal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForSelector(".calendar-form", {hidden: true});
    check("canceling with changes asks first", true);

    // Escape closes a form without changes.
    await page.click(".calendar-new-menu-button");
    await page.waitForSelector(".calendar-card-choices", {visible: true});
    await page.click(".calendar-card-choice");
    await wait_for_form(page);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".calendar-form", {hidden: true});
    check("Escape closes a form without changes", true);

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await open_week(page, week_hash);
    await page.click(".calendar-new-event-button");
    await wait_for_form(page);
    await page.click(".calendar-form-attendee-options");
    await page.waitForSelector(".calendar-form-attendee-options-menu", {visible: true});
    await shot(page, "light-ru-new");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".calendar-form-attendee-options-menu", {hidden: true});
    check("Escape closes an open menu, not the form", (await page.$(".calendar-form")) !== null);
    for (const width of [1024, 480]) {
        await page.setViewport({width, height: 900});
        await new Promise((resolve) => setTimeout(resolve, 300));
        const layout = await page.$eval(".calendar-form", (form) => ({
            scroll_width: form.scrollWidth,
            client_width: form.clientWidth,
            fields_width: form.querySelector(".calendar-form-fields")!.getBoundingClientRect()
                .width,
        }));
        check(
            `at ${width}px the form fits the window, with room for the fields`,
            layout.scroll_width <= layout.client_width && layout.fields_width >= 400,
            JSON.stringify(layout),
        );
        await shot(page, `light-ru-${width}`);
    }
    await page.setViewport({width: 1440, height: 900});

    // An all-day event has no time.
    await page.click(".calendar-form-time-summary");
    await page.click(".calendar-form-all-day-checkbox");
    check(
        "an all-day event has no time",
        !(await is_shown(page, ".calendar-form-start")) &&
            !(await is_shown(page, ".calendar-form-end")) &&
            (await page.$(".calendar-form-day-block")) === null,
    );
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_form_test);
