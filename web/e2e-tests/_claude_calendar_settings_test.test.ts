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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-settings";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json

from zerver.lib.calendar.user_settings import (
    calendar_user_settings_to_api_dict,
    get_calendar_user_settings,
    update_calendar_user_settings,
)
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

desdemona = get_user_by_delivery_email("desdemona@zulip.com", get_realm("zulip"))
`;

function get_settings(): Record<string, unknown> {
    return z
        .record(z.string(), z.unknown())
        .parse(
            JSON.parse(
                run_python(
                    python_prelude +
                        `print("SETTINGS " + json.dumps(calendar_user_settings_to_api_dict(get_calendar_user_settings(desdemona))))`,
                ).split("SETTINGS ", 2)[1]!,
            ),
        );
}

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

async function text(page: Page, selector: string): Promise<string> {
    return await page.$eval(selector, (element) =>
        element.textContent.trim().replaceAll(/\s+/g, " "),
    );
}

async function selected_label(page: Page, id: string): Promise<string> {
    return await page.$eval(`#${id}`, (element) => {
        if (!(element instanceof HTMLSelectElement)) {
            throw new TypeError("Expected <select>");
        }
        return element.selectedOptions[0]!.textContent.trim();
    });
}

async function wait_for_status(page: Page, subsection: string, status: string): Promise<void> {
    await page.waitForFunction(
        (selector, status) => document.querySelector(selector)?.textContent.includes(status),
        {},
        `.${subsection} .alert-notification`,
        status,
    );
}

async function day_columns(page: Page): Promise<number> {
    return await page.$$eval("#calendar-view .calendar-day-column", (columns) => columns.length);
}

async function calendar_settings_test(page: Page): Promise<void> {
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // The calendar section of the personal settings shows the defaults.
    await page.goto(`${base_url}#settings/calendar`);
    await page.waitForSelector("#calendar_work_day_start_minutes", {visible: true});
    const work_days = await page.$$eval(".calendar-settings-work-day-checkbox", (checkboxes) =>
        checkboxes.map((checkbox) => {
            if (!(checkbox instanceof HTMLInputElement)) {
                throw new TypeError("Expected <input>");
            }
            return checkbox.checked;
        }),
    );
    const defaults = [
        await selected_label(page, "calendar_work_day_start_minutes"),
        await selected_label(page, "calendar_work_day_end_minutes"),
        await selected_label(page, "calendar_default_view"),
        await selected_label(page, "calendar_time_scale_minutes"),
        await selected_label(page, "calendar_default_reminder_minutes"),
    ];
    check(
        "the section shows the defaults",
        JSON.stringify(work_days) ===
            JSON.stringify([true, true, true, true, true, false, false]) &&
            JSON.stringify(defaults) ===
                JSON.stringify([
                    "9:00 AM",
                    "6:00 PM",
                    "Work week",
                    "30 minutes",
                    "15 minutes before",
                ]),
        JSON.stringify(defaults),
    );
    await shot(page, "section-dark");

    // Changes are saved right away.
    await page.click('label[for="calendar_work_day_5"]');
    await wait_for_status(page, "calendar-work-time-settings", "Saved");
    await page.click('label[for="calendar_work_day_6"]');
    await page.waitForFunction(() =>
        document
            .querySelector(".calendar-work-time-settings .alert-notification")
            ?.textContent.includes("Saved"),
    );
    await page.select("#calendar_work_day_start_minutes", "480");
    await page.select("#calendar_work_day_end_minutes", "1020");
    await page.select("#calendar_default_reminder_minutes", "");
    await wait_for_status(page, "calendar-view-settings", "Saved");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const saved = get_settings();
    check(
        "changes are saved",
        JSON.stringify(saved["work_days"]) === JSON.stringify([1, 2, 3, 4, 6]) &&
            saved["work_day_start_minutes"] === 480 &&
            saved["work_day_end_minutes"] === 1020 &&
            saved["default_reminder_minutes"] === null,
        JSON.stringify(saved),
    );

    // A work day that ends before it starts is refused and undone.
    await page.select("#calendar_work_day_start_minutes", "1080");
    await wait_for_status(page, "calendar-work-time-settings", "Invalid work hours");
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLSelectElement>("#calendar_work_day_start_minutes")!.value ===
            "480",
    );
    check(
        "invalid work hours are refused and undone",
        get_settings()["work_day_start_minutes"] === 480,
    );
    await shot(page, "invalid-dark");

    // A change from another client shows in the section.
    run_python(python_prelude + "update_calendar_user_settings(desdemona, time_scale_minutes=60)");
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLSelectElement>("#calendar_time_scale_minutes")!.value ===
            "60",
    );
    check("changes from other clients show", true);

    // The calendar opens in the default view, and the work week shows
    // the work days.
    await page.select("#calendar_default_view", "week");
    await wait_for_status(page, "calendar-view-settings", "Saved");
    await page.goto(`${base_url}#calendar`);
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-day-column", {
        visible: true,
    });
    check(
        "the calendar opens in the default view",
        page.url().includes("#calendar/week/") && (await day_columns(page)) === 7,
        page.url(),
    );
    await page.click("#calendar-view .calendar-view-button");
    await page.waitForSelector("#calendar-view-menu", {visible: true});
    await page.click('.calendar-view-option[data-calendar-view="workweek"]');
    await page.waitForFunction(() => window.location.hash.includes("#calendar/workweek/"));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    check(
        "the work week shows the work days, and becomes the default view",
        (await day_columns(page)) === 5 && get_settings()["default_view"] === 2,
        String(await day_columns(page)),
    );

    // Changing the work days elsewhere redraws the week.
    run_python(python_prelude + "update_calendar_user_settings(desdemona, work_days=[1, 2, 3])");
    await page.waitForFunction(
        () => document.querySelectorAll("#calendar-view .calendar-day-column").length === 3,
    );
    check("the week follows changes from other clients", true);

    // The view menu leads to these settings.
    await page.click("#calendar-view .calendar-view-button");
    await page.waitForSelector(".calendar-settings-option", {visible: true});
    await shot(page, "menu-dark");
    await page.click(".calendar-settings-option");
    await page.waitForSelector("#calendar_work_day_start_minutes", {visible: true});
    check(
        "the view menu opens the calendar settings",
        page.url().endsWith("#settings/calendar") &&
            (await selected_label(page, "calendar_default_view")) === "Work week",
        page.url(),
    );

    // In Russian, and in the light theme.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await page.reload();
    await page.waitForSelector("#calendar_work_day_start_minutes", {visible: true});
    const labels = await page.$$eval(".calendar-settings-work-day label.inline", (elements) =>
        elements.map((element) => element.textContent.trim()),
    );
    check(
        "the section is in Russian",
        labels[0] === "Понедельник" &&
            (await text(page, "#calendar-settings h3")) === "Рабочее время",
        `${labels.join(", ")} / ${await text(page, "#calendar-settings h3")}`,
    );
    await shot(page, "section-light-ru");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");
    run_python(
        python_prelude +
            "update_calendar_user_settings(desdemona, work_days=[1, 2, 3, 4, 5], work_day_start_minutes=540, work_day_end_minutes=1080, default_reminder_minutes=15, default_view=2, time_scale_minutes=30)",
    );

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_settings_test);
