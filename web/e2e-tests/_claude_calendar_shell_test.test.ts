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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-shell";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Othello invites Desdemona, who is logged in, to a meeting tomorrow.
const seed_script = String.raw`import json
from datetime import timedelta

from django.utils.timezone import now as timezone_now

from zerver.actions.message_flags import do_mark_all_as_read
from zerver.lib.calendar.changes import create_calendar_event
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
othello = get_user_by_delivery_email("othello@zulip.com", realm)
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
start = timezone_now().replace(minute=0, second=0, microsecond=0) + timedelta(days=1)
event_id = create_calendar_event(
    othello,
    title="Calendar shell",
    start=start,
    end=start + timedelta(minutes=30),
    event_timezone="Europe/Moscow",
    required_attendees=[desdemona],
    optional_attendees=[],
)
# The invitation from Notification Bot would add its unread count to
# the window title.
do_mark_all_as_read(desdemona)
print(
    "SEEDED "
    + json.dumps({"event_id": event_id, "denmark": get_stream("Denmark", realm).id})
)
`;

const seeded_schema = z.object({event_id: z.number(), denmark: z.number()});

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
    // Let fonts settle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function current_hash(page: Page): Promise<string> {
    return await page.evaluate(() => window.location.hash);
}

async function is_calendar_visible(page: Page): Promise<boolean> {
    return await page.evaluate(() => document.body.classList.contains("calendar-view-visible"));
}

async function wait_for_calendar(page: Page, visible: boolean): Promise<void> {
    await page.waitForFunction(
        (visible) => document.body.classList.contains("calendar-view-visible") === visible,
        {polling: 100},
        visible,
    );
}

async function range_label(page: Page): Promise<string> {
    return await page.$eval(".calendar-range-label", (element) => element.textContent.trim());
}

async function navbar_count(page: Page): Promise<string> {
    return await page.$eval("#calendar-navbar-button .calendar-navbar-count", (element) =>
        element.classList.contains("hide") ? "" : element.textContent.trim(),
    );
}

function monday_of_this_week(): string {
    const today = new Date();
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

async function calendar_shell_test(page: Page): Promise<void> {
    const seeded = seeded_schema.parse(JSON.parse(run_python(seed_script).split("SEEDED ", 2)[1]!));

    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    await page.reload();
    await page.waitForSelector("#calendar-navbar-button", {visible: true});

    check("the navbar button counts the invitation", (await navbar_count(page)) === "1");

    // Open the calendar from a channel and mark a message row, which
    // must still be there when coming back.
    const channel_hash = `#narrow/channel/${seeded.denmark}-Denmark`;
    await page.goto(`${base_url}${channel_hash}`);
    await page.waitForSelector(".message-list .message_row", {visible: true});
    await page.evaluate(() => {
        document.querySelector(".message-list .message_row")!.classList.add("calendar-test-marker");
    });
    const history_length = await page.evaluate(() => window.history.length);

    await page.click("#calendar-navbar-button");
    await wait_for_calendar(page, true);
    check(
        "the calendar opens on the work week of today",
        (await current_hash(page)) === `#calendar/workweek/${monday_of_this_week()}`,
        await current_hash(page),
    );
    check(
        "the window title names the calendar",
        (await page.title()).startsWith("Calendar - "),
        await page.title(),
    );
    const sidebars_hidden = await page.evaluate(
        () =>
            document.querySelector("#calendar-view")!.getBoundingClientRect().left === 0 &&
            getComputedStyle(document.querySelector("#userlist-toggle")!).visibility === "hidden",
    );
    check("the calendar covers the window under the navbar", sidebars_hidden);
    await shot(page, "dark-week");

    await page.click(".calendar-next-week");
    await page.click(".calendar-next-week");
    await page.click(".calendar-previous-week");
    const next_week = await current_hash(page);
    check("the arrows move by a week", next_week !== `#calendar/workweek/${monday_of_this_week()}`);
    check(
        "moving between weeks adds nothing to the history",
        (await page.evaluate(() => window.history.length)) === history_length + 1,
    );
    await page.click(".calendar-today-button");
    check(
        "Today goes back to this week",
        (await current_hash(page)) === `#calendar/workweek/${monday_of_this_week()}`,
    );

    // Hotkeys for the message feed don't reach the feed behind.
    await page.keyboard.press("c");
    check(
        "the compose hotkey does nothing in the calendar",
        await page.evaluate(() => document.activeElement?.id !== "compose-textarea"),
    );

    // The view menu.
    await page.click(".calendar-view-button");
    await page.waitForSelector("#calendar-view-menu", {visible: true});
    await shot(page, "dark-view-menu");
    await page.click('.calendar-view-option[data-calendar-view="week"]');
    await page.waitForSelector("#calendar-view-menu", {hidden: true});
    check(
        "the view menu switches to the week",
        (await current_hash(page)).startsWith("#calendar/week/") &&
            (await page.$eval(".calendar-view-label", (element) => element.textContent)) === "Week",
    );

    // The date picker.
    await page.click(".calendar-range-button");
    await page.waitForSelector(".calendar-date-picker-popover", {visible: true});
    await shot(page, "dark-date-picker");
    await page.click(".calendar-date-picker-popover .calendar-mini-month-next");
    const picked_day = await page.$eval(
        ".calendar-date-picker-popover .calendar-mini-month-week:nth-child(5) .calendar-mini-month-day:nth-child(3)",
        (element) => {
            if (!(element instanceof HTMLElement)) {
                throw new TypeError("Expected an HTML element");
            }
            return element.dataset["date"]!;
        },
    );
    await page.click(
        ".calendar-date-picker-popover .calendar-mini-month-week:nth-child(5) .calendar-mini-month-day:nth-child(3)",
    );
    await page.waitForSelector(".calendar-date-picker-popover", {hidden: true});
    const picked_hash = await current_hash(page);
    check(
        "a day in the date picker shows its week",
        new Date(`${picked_hash.split("/", 3)[2]}T00:00`).getDay() === 1 &&
            (new Date(`${picked_day}T00:00`).getTime() -
                new Date(`${picked_hash.split("/", 3)[2]}T00:00`).getTime()) /
                86_400_000 ===
                2,
        `${picked_day} ${picked_hash}`,
    );

    // Collapsing the left panel.
    await page.click(".calendar-toggle-left-panel");
    check(
        "the left panel collapses",
        await page.$eval(
            ".calendar-left-panel",
            (element) => getComputedStyle(element).display === "none",
        ),
    );
    await page.click(".calendar-toggle-left-panel");

    // The button goes back to the channel, which was not rerendered.
    await page.click("#calendar-navbar-button");
    await wait_for_calendar(page, false);
    check(
        "the button returns to the channel without rerendering it",
        (await current_hash(page)) === channel_hash &&
            (await page.$(".calendar-test-marker")) !== null,
        await current_hash(page),
    );

    // So does the browser's back button.
    await page.click("#calendar-navbar-button");
    await wait_for_calendar(page, true);
    await page.goBack();
    await wait_for_calendar(page, false);
    check(
        "the back button returns to the channel without rerendering it",
        (await current_hash(page)) === channel_hash &&
            (await page.$(".calendar-test-marker")) !== null,
        await current_hash(page),
    );

    // A message link in the calendar leads to the chat.
    await page.click("#calendar-navbar-button");
    await wait_for_calendar(page, true);
    await page.evaluate((hash) => {
        const link = document.createElement("a");
        link.href = hash;
        link.className = "calendar-test-link";
        link.textContent = "link";
        document.querySelector(".calendar-grid-container")!.append(link);
    }, `#narrow/channel/${seeded.denmark}-Denmark/topic/calendar`);
    await page.click(".calendar-test-link");
    await wait_for_calendar(page, false);
    check(
        "a link to a topic leaves the calendar",
        (await current_hash(page)).endsWith("/topic/calendar") &&
            !(await is_calendar_visible(page)),
    );

    // Opening a calendar URL directly.
    await page.goto(`${base_url}#calendar/week/2026-11-11`);
    await page.reload();
    await wait_for_calendar(page, true);
    check(
        "a calendar URL opens its week",
        (await current_hash(page)) === "#calendar/week/2026-11-09" &&
            (await range_label(page)) === "November 9 – 15, 2026",
        `${await current_hash(page)} ${await range_label(page)}`,
    );
    await page.click("#calendar-navbar-button");
    await wait_for_calendar(page, false);
    check(
        "from a calendar URL, the button goes to the home view",
        (await current_hash(page)) === "#inbox",
        await current_hash(page),
    );

    // Answering the invitation updates the count live.
    await request(page, "POST", `/json/calendar/events/${seeded.event_id}/response`, "response=2");
    await page.waitForFunction(
        () =>
            document
                .querySelector("#calendar-navbar-button .calendar-navbar-count")
                ?.classList.contains("hide") === true,
        {polling: 100},
    );
    check("answering the invitation clears the count", (await navbar_count(page)) === "");

    // Light theme in Russian, with a larger font in a narrow window.
    await request(
        page,
        "PATCH",
        "/json/settings",
        "color_scheme=3&default_language=ru&web_font_size_px=17",
    );
    await page.setViewport({width: 1024, height: 768});
    await page.goto(`${base_url}#calendar/week/2026-12-30`);
    await page.reload();
    await wait_for_calendar(page, true);
    const toolbar = await page.$eval(".calendar-toolbar", (element) => {
        const centers = [...element.children]
            .map((child) => child.getBoundingClientRect())
            .filter((rect) => rect.width > 0)
            .map((rect) => rect.top + rect.height / 2);
        return {
            one_line: centers.every((center) => Math.abs(center - centers[0]!) < 1),
            fits: element.scrollWidth <= element.clientWidth,
        };
    });
    check(
        "the toolbar fits on one line",
        toolbar.one_line && toolbar.fits,
        JSON.stringify(toolbar),
    );
    check(
        "the title is in Russian",
        (await page.title()).startsWith("Календарь - "),
        await page.title(),
    );
    await shot(page, "light-ru-narrow");
    await request(
        page,
        "PATCH",
        "/json/settings",
        "color_scheme=1&default_language=en&web_font_size_px=16",
    );

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_shell_test);
