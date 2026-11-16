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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-colleagues";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import (
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
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
cordelia = get_user_by_delivery_email("cordelia@zulip.com", realm)
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

// Othello's week, as Desdemona sees it.
const seed_script =
    python_prelude +
    String.raw`
do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
event(othello, "Othello alone", at(0, 10), at(0, 11))
event(othello, "Secret plan", at(0, 12), at(0, 13), is_private=True)
event(othello, "Shared meeting", at(1, 10), at(1, 11), [desdemona])
maybe = event(cordelia, "Maybe", at(1, 14), at(1, 15), [othello])
respond_to_calendar_event(othello, maybe, CalendarResponse.TENTATIVE, None)
event(othello, "Lunch break", at(2, 13), at(2, 14), show_as=CalendarShowAs.FREE)
event(othello, "Vacation", at(3, 9), at(3, 18), show_as=CalendarShowAs.OOF)
event(othello, "From home", at(4, 9), at(4, 12), show_as=CalendarShowAs.WORKING_ELSEWHERE)
event(hamlet, "Hamlet busy", at(0, 10), at(0, 11))
print("SEEDED " + json.dumps({"monday": monday.isoformat()}))
`;

const live_script =
    python_prelude +
    String.raw`
event(othello, "Late call", at(4, 16), at(4, 17))
print("CREATED")
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

async function wait_for_week(page: Page): Promise<void> {
    await page.waitForSelector(".calendar-grid:not(.loading) .calendar-day-column", {
        visible: true,
    });
}

async function add_colleague(page: Page, name: string): Promise<void> {
    await page.click("#calendar-add-colleague_widget");
    await page.waitForSelector(".calendar-add-colleague-dropdown-list-container", {visible: true});
    await page.type(".dropdown-list-search-input", name.split(",", 1)[0]!);
    await page.waitForFunction(
        (name) =>
            [...document.querySelectorAll(".dropdown-list-item-common-styles")].some(
                (item) => item.textContent.trim() === name,
            ),
        {polling: 100},
        name,
    );
    await page.evaluate((name) => {
        const items = [
            ...document.querySelectorAll<HTMLElement>(".dropdown-list-item-common-styles"),
        ];
        items.find((item) => item.textContent.trim() === name)!.click();
    }, name);
    await page.waitForFunction(
        (name) =>
            [...document.querySelectorAll(".calendar-colleague .calendar-list-item-name")].some(
                (item) => item.textContent.trim() === name,
            ),
        {polling: 100},
        name,
    );
    await wait_for_week(page);
}

async function list_state(page: Page): Promise<string[]> {
    return await page.$$eval(".calendar-colleague", (rows) =>
        rows.map(
            (row) =>
                `${row.querySelector(".calendar-list-item-name")!.textContent.trim()}:${
                    row.querySelector<HTMLInputElement>("input")!.checked ? "on" : "off"
                }`,
        ),
    );
}

async function calendar_names(page: Page): Promise<string[]> {
    return await page.$$eval(".calendar-grid-calendar-name", (names) =>
        names.map((name) => name.textContent.trim()),
    );
}

async function busy_blocks(page: Page): Promise<string[]> {
    return await page.$$eval(".calendar-grid .calendar-event.free-busy", (blocks) =>
        blocks.map(
            (block) =>
                `${block.querySelector(".calendar-event-title")!.textContent.trim()}|${[
                    ...block.classList,
                ]
                    .filter((name) =>
                        ["busy", "tentative", "free", "away", "elsewhere"].includes(name),
                    )
                    .join(",")}`,
        ),
    );
}

async function calendar_colleagues_test(page: Page): Promise<void> {
    const seeded = z
        .object({monday: z.string()})
        .parse(JSON.parse(run_python(seed_script).split("SEEDED ", 2)[1]!));
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    const week_hash = `#calendar/workweek/${seeded.monday}`;
    await page.goto(`${base_url}${week_hash}`);
    await page.reload();
    await wait_for_week(page);

    check(
        "without colleagues, only my calendar shows",
        (await page.$(".calendar-grid.side-by-side")) === null &&
            !(await page.$eval(".calendar-legend", (legend) => legend.checkVisibility())),
    );

    await add_colleague(page, "Othello, the Moor of Venice");
    check(
        "an added colleague is listed and shown side by side",
        JSON.stringify(await list_state(page)) ===
            JSON.stringify(["Othello, the Moor of Venice:on"]) &&
            JSON.stringify(await calendar_names(page)) ===
                JSON.stringify(["My calendar", "Othello, the Moor of Venice"]),
        JSON.stringify(await list_state(page)),
    );
    check(
        "the view says side by side",
        (await page.$eval(".calendar-view-label", (label) => label.textContent)) ===
            "Work week · side by side",
    );
    check(
        "the legend shows",
        await page.$eval(".calendar-legend", (legend) => legend.checkVisibility()),
    );
    const blocks = await busy_blocks(page);
    check(
        "a colleague shows busy times without titles, except shared meetings",
        JSON.stringify(blocks) ===
            JSON.stringify([
                "Busy|busy",
                "Busy|busy",
                "Shared meeting|busy",
                "Tentative|tentative",
                "Free|free",
                "Away|away",
                "Working elsewhere|elsewhere",
            ]),
        JSON.stringify(blocks),
    );
    await shot(page, "dark-side-by-side");

    // More colleagues than fit scroll sideways, with the hours in sight.
    await add_colleague(page, "King Hamlet");
    await add_colleague(page, "Cordelia, Lear's daughter");
    const scrolling = await page.evaluate(() => {
        const container = document.querySelector(".calendar-grid-container")!;
        container.scrollLeft = 300;
        const hours = document.querySelector(".calendar-time-column")!.getBoundingClientRect();
        const column = document.querySelector(".calendar-day-column")!.getBoundingClientRect();
        return {
            scrolls: container.scrollWidth > container.clientWidth,
            hours_in_place: Math.abs(hours.left - container.getBoundingClientRect().left) < 1,
            column_width: column.width,
        };
    });
    check(
        "many calendars scroll sideways, keeping the hours in sight",
        scrolling.scrolls && scrolling.hours_in_place && scrolling.column_width >= 84,
        JSON.stringify(scrolling),
    );
    await shot(page, "dark-three-colleagues");
    await page.evaluate(() => {
        document.querySelector(".calendar-grid-container")!.scrollLeft = 0;
    });

    // The × of a calendar hides it, and keeps it in the list.
    await page.evaluate(() => {
        const headers = [...document.querySelectorAll(".calendar-grid-calendar-header")];
        const hamlet = headers.find((header) => header.textContent.includes("King Hamlet"))!;
        hamlet.querySelector<HTMLElement>(".calendar-grid-calendar-close")!.click();
    });
    await wait_for_week(page);
    check(
        "the × of a calendar hides it",
        JSON.stringify(await calendar_names(page)) ===
            JSON.stringify([
                "My calendar",
                "Othello, the Moor of Venice",
                "Cordelia, Lear's daughter",
            ]) && (await list_state(page)).includes("King Hamlet:off"),
        JSON.stringify(await list_state(page)),
    );

    // A colleague's new event shows without reloading.
    const block_count = (await busy_blocks(page)).length;
    run_python(live_script);
    await page.waitForFunction(
        (block_count) =>
            document.querySelectorAll(".calendar-day-column .calendar-event.free-busy").length >
            block_count,
        {polling: 200, timeout: 10_000},
        block_count,
    );
    check("a colleague's new event shows without reloading", true);

    // The list and the shown calendars stay after reloading.
    await page.reload();
    await wait_for_week(page);
    await page.waitForSelector(".calendar-colleague");
    check(
        "the list and the shown calendars stay after reloading",
        JSON.stringify(await list_state(page)) ===
            JSON.stringify([
                "Othello, the Moor of Venice:on",
                "King Hamlet:off",
                "Cordelia, Lear's daughter:on",
            ]) && (await calendar_names(page)).length === 3,
        JSON.stringify(await list_state(page)),
    );

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await page.reload();
    await wait_for_week(page);
    await page.waitForSelector(".calendar-colleague");
    await shot(page, "light-ru-side-by-side");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");
    await page.reload();
    await wait_for_week(page);

    // Unchecking every colleague leaves my calendar alone.
    for (const name of ["Othello, the Moor of Venice", "Cordelia, Lear's daughter"]) {
        await page.evaluate((name) => {
            const rows = [...document.querySelectorAll(".calendar-colleague")];
            const row = rows.find((row) => row.textContent.includes(name))!;
            row.querySelector<HTMLInputElement>("input")!.click();
        }, name);
    }
    await wait_for_week(page);
    check(
        "unchecking every colleague leaves my calendar alone",
        (await page.$(".calendar-grid.side-by-side")) === null &&
            (await page.$eval(".calendar-view-label", (label) => label.textContent)) ===
                "Work week",
    );

    // The × of a row removes the colleague.
    await page.hover(".calendar-colleague");
    await page.click(".calendar-colleague .calendar-colleague-remove");
    await page.waitForFunction(
        () => document.querySelectorAll(".calendar-colleague").length === 2,
        {polling: 100},
    );
    const pinned = z
        .object({pinned_users: z.array(z.object({user_id: z.number()}))})
        .parse(await request(page, "GET", "/json/calendar/pinned_users", ""));
    check(
        "the × of a row removes the colleague",
        pinned.pinned_users.length === 2 &&
            (await list_state(page)).every((row) => !row.startsWith("Othello")),
        JSON.stringify(await list_state(page)),
    );

    // Long lists show their first colleagues.
    const user_ids = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".calendar-colleague input")].map((input) =>
            Number(input.dataset["userId"]),
        ),
    );
    const me = z
        .object({user_id: z.number()})
        .parse(await request(page, "GET", "/json/users/me", ""));
    const others = z
        .object({
            members: z.array(
                z.object({user_id: z.number(), is_bot: z.boolean(), is_active: z.boolean()}),
            ),
        })
        .parse(await request(page, "GET", "/json/users", ""));
    const more = others.members
        .filter(
            (user) =>
                !user.is_bot &&
                user.is_active &&
                user.user_id !== me.user_id &&
                !user_ids.includes(user.user_id),
        )
        .slice(0, 4);
    for (const [index, user] of more.entries()) {
        await request(
            page,
            "POST",
            "/json/calendar/pinned_users",
            `user_id=${user.user_id}&color=%23${["c25e00", "c4314b", "b4009e", "8f6b00"][index]}`,
        );
    }
    await page.reload();
    await wait_for_week(page);
    await page.waitForSelector(".calendar-show-all-button");
    const visible_rows = async (): Promise<number> =>
        await page.$$eval(
            ".calendar-colleague",
            (rows) => rows.filter((row) => row.checkVisibility()).length,
        );
    const before = await visible_rows();
    await page.click(".calendar-show-all-button");
    const after = await visible_rows();
    check(
        "Show all shows the rest of a long list",
        before === 5 &&
            after === 6 &&
            (await page.$eval(".calendar-show-all-button", (button) =>
                button.textContent.trim(),
            )) === "Show less",
        `${before} ${after}`,
    );
    await shot(page, "dark-long-list");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_colleagues_test);
