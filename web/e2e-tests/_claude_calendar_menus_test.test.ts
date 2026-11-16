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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-menus";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Desdemona's week in Moscow, with an event of each kind the filter
// knows, Monday to Friday.
const seed_script = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import (
    create_calendar_event,
    respond_to_calendar_event,
    update_calendar_attendee_settings,
)
from zerver.models.calendar import CalendarResponse
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


def event(organizer, title, day, hour, attendees=(), **kwargs):
    return create_calendar_event(
        organizer,
        title=title,
        start=at(day, hour),
        end=at(day, hour + 1),
        event_timezone="Europe/Moscow",
        required_attendees=list(attendees),
        optional_attendees=[],
        **kwargs,
    )


do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
event(desdemona, "Personal", 0, 9)
event(desdemona, "Organized", 0, 11, [othello])
accepted = event(othello, "Accepted", 1, 9, [desdemona])
respond_to_calendar_event(desdemona, accepted, CalendarResponse.ACCEPTED)
tentative = event(othello, "Tentative", 1, 11, [desdemona])
respond_to_calendar_event(desdemona, tentative, CalendarResponse.TENTATIVE)
event(othello, "Unanswered", 2, 9, [desdemona])
followed = event(othello, "Followed", 2, 11, [desdemona])
respond_to_calendar_event(desdemona, followed, CalendarResponse.FOLLOWING)
red = event(othello, "Red", 3, 9, [desdemona])
respond_to_calendar_event(desdemona, red, CalendarResponse.ACCEPTED)
update_calendar_attendee_settings(desdemona, red, category="Red category")
event(desdemona, "Series", 4, 9, [othello], rrule="FREQ=WEEKLY;BYDAY=FR")
print("SEEDED " + json.dumps({"monday": monday.isoformat(), "othello": othello.id}))
`;

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
                body: method === "GET" ? null : body,
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

async function shown_titles(page: Page): Promise<string[]> {
    return await page.$$eval(
        ".calendar-grid .calendar-day-column .calendar-event-title",
        (titles) => titles.map((title) => title.textContent.trim()).toSorted(),
    );
}

async function open_menu(page: Page, trigger: string, menu: string): Promise<void> {
    await page.click(`${trigger} button`);
    await page.waitForSelector(menu, {visible: true});
}

async function close_menus(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
        () => document.querySelector("#calendar-view-menu, #calendar-filter-menu") === null,
        {polling: 100},
    );
}

async function open_submenu(page: Page, item: string, submenu: string): Promise<void> {
    await page.hover(item);
    await page.waitForSelector(`.calendar-submenu[data-submenu="${submenu}"]`, {visible: true});
}

async function click_option(page: Page, selector: string, label: string): Promise<void> {
    await page.evaluate(
        (selector, label) => {
            const options = [...document.querySelectorAll<HTMLElement>(selector)];
            options
                .find((option) =>
                    option
                        .querySelector(".popover-menu-label")!
                        .textContent.trim()
                        .startsWith(label),
                )!
                .click();
        },
        selector,
        label,
    );
}

async function checked_state(page: Page, option: string): Promise<string | null> {
    return await page.$eval(`.calendar-filter-option[data-filter-option="${option}"]`, (item) =>
        item.getAttribute("aria-checked"),
    );
}

async function calendar_menus_test(page: Page): Promise<void> {
    const seeded = z
        .object({monday: z.string(), othello: z.number()})
        .parse(JSON.parse(run_python(seed_script).split("SEEDED ", 2)[1]!));
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    const week_hash = `#calendar/workweek/${seeded.monday}`;
    await open_week(page, week_hash);
    const all_titles = await shown_titles(page);
    check(
        "every event shows without a filter",
        all_titles.length === 8,
        JSON.stringify(all_titles),
    );

    // The view menu.
    await open_menu(page, ".calendar-view-menu-trigger", "#calendar-view-menu");
    const labels = await page.$$eval("#calendar-view-menu .popover-menu-label", (items) =>
        items.map((item) => item.textContent.trim()),
    );
    check(
        "the view menu has the views, side by side, the time scale and the settings",
        JSON.stringify(labels) ===
            JSON.stringify([
                "Work week",
                "Week",
                "Colleagues' calendars side by side",
                "Time scale",
                "Calendar settings",
            ]) &&
            (await page.$eval(".calendar-menu-value", (value) => value.textContent.trim())) ===
                "30 minutes",
        JSON.stringify(labels),
    );
    await open_submenu(page, '.calendar-submenu-trigger[data-submenu="time_scale"]', "time_scale");
    await shot(page, "dark-time-scale");
    await click_option(page, ".calendar-submenu-option", "60 minutes");
    await page.waitForFunction(
        () =>
            Math.abs(
                document.querySelector(".calendar-day-column")!.getBoundingClientRect().height /
                    24 -
                    42,
            ) < 1,
        {polling: 100},
    );
    const settings = z
        .object({settings: z.object({time_scale_minutes: z.number()})})
        .parse(await request(page, "GET", "/json/calendar/settings", ""));
    check(
        "the time scale changes the grid and is saved",
        settings.settings.time_scale_minutes === 60 &&
            (await page.$eval(".calendar-menu-value", (value) => value.textContent.trim())) ===
                "60 minutes",
    );
    await close_menus(page);

    // Side by side hides colleagues without unchecking them.
    await request(
        page,
        "POST",
        "/json/calendar/pinned_users",
        `user_id=${seeded.othello}&color=%232f6fc4`,
    );
    await open_week(page, week_hash);
    await page.click(".calendar-colleague input");
    await page.waitForSelector(".calendar-grid.side-by-side");
    await open_menu(page, ".calendar-view-menu-trigger", "#calendar-view-menu");
    await page.click(".calendar-side-by-side-option");
    await page.waitForFunction(
        () => document.querySelector(".calendar-grid.side-by-side") === null,
    );
    check(
        "turning side by side off hides the colleagues, who stay checked",
        await page.$eval(".calendar-colleague input", (input) => input.checked),
    );
    await open_menu(page, ".calendar-view-menu-trigger", "#calendar-view-menu");
    await page.click(".calendar-side-by-side-option");
    await page.waitForSelector(".calendar-grid.side-by-side");
    check("turning it on shows them again", true);
    await page.click(".calendar-colleague input");
    await page.waitForFunction(
        () => document.querySelector(".calendar-grid.side-by-side") === null,
    );

    // The filter.
    await open_menu(page, ".calendar-filter-menu-trigger", "#calendar-filter-menu");
    const filter_labels = await page.$$eval("#calendar-filter-menu .popover-menu-label", (items) =>
        items.map((item) => item.textContent.trim()),
    );
    check(
        "the filter menu leaves out channel meetings",
        JSON.stringify(filter_labels) ===
            JSON.stringify([
                "Reset filters",
                "Personal events",
                "Meetings",
                "Categories",
                "Show as",
                "Recurring events",
            ]),
        JSON.stringify(filter_labels),
    );
    await page.click('.calendar-filter-option[data-filter-option="personal"]');
    await open_submenu(page, '.calendar-filter-option[data-filter-option="meetings"]', "meetings");
    await shot(page, "dark-filter-meetings");
    await click_option(page, ".calendar-submenu-option", "Not answered");
    await click_option(page, ".calendar-submenu-option", "Following");
    check(
        "a group with some options hidden is mixed",
        (await checked_state(page, "meetings")) === "mixed" &&
            (await checked_state(page, "personal")) === "false",
    );
    await open_submenu(
        page,
        '.calendar-filter-option[data-filter-option="categories"]',
        "categories",
    );
    await click_option(page, ".calendar-submenu-option", "Red category");
    await open_submenu(page, '.calendar-filter-option[data-filter-option="show_as"]', "show_as");
    await click_option(page, ".calendar-submenu-option", "Tentative");
    await page.click('.calendar-filter-option[data-filter-option="recurring"]');
    const filtered = await shown_titles(page);
    check(
        "the filter hides the events it says",
        JSON.stringify(filtered) === JSON.stringify(["Accepted", "Organized"]),
        JSON.stringify(filtered),
    );
    check(
        "the filter button is marked while something is hidden",
        (await page.$(".calendar-filter-button.active")) !== null,
    );
    await close_menus(page);

    await open_week(page, week_hash);
    check(
        "the filter stays after reloading",
        JSON.stringify(await shown_titles(page)) === JSON.stringify(["Accepted", "Organized"]) &&
            (await page.$(".calendar-filter-button.active")) !== null,
    );

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await open_week(page, week_hash);
    await open_menu(page, ".calendar-filter-menu-trigger", "#calendar-filter-menu");
    await open_submenu(page, '.calendar-filter-option[data-filter-option="show_as"]', "show_as");
    await shot(page, "light-ru-filter");
    await close_menus(page);
    await open_menu(page, ".calendar-view-menu-trigger", "#calendar-view-menu");
    await open_submenu(page, '.calendar-submenu-trigger[data-submenu="time_scale"]', "time_scale");
    await shot(page, "light-ru-view-menu");
    await close_menus(page);
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");
    await open_week(page, week_hash);

    await open_menu(page, ".calendar-filter-menu-trigger", "#calendar-filter-menu");
    await page.click(".calendar-filter-reset");
    await page.waitForFunction(
        () => document.querySelector(".calendar-filter-button.active") === null,
    );
    check(
        "resetting the filter shows every event",
        (await shown_titles(page)).length === all_titles.length &&
            (await checked_state(page, "meetings")) === "true",
    );
    await close_menus(page);
    await request(page, "PATCH", "/json/calendar/settings", "time_scale_minutes=30");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_menus_test);
