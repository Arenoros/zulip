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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-card";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Desdemona's week in Moscow: an invitation from Othello, a series she
// organizes with Othello, a single meeting she organizes, and a
// personal event.
const seed_script = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event, respond_to_calendar_event
from zerver.models.calendar import CalendarResponse
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
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
invitation = event(
    othello, "Review", 0, 12, [desdemona, hamlet], location="Room 4", rrule="FREQ=DAILY"
)
respond_to_calendar_event(hamlet, invitation, CalendarResponse.ACCEPTED)
event(desdemona, "Planning", 1, 9, [othello], rrule="FREQ=WEEKLY;BYDAY=TU", has_zulip_call=True)
event(desdemona, "Single", 2, 9, [othello])
event(desdemona, "Gym", 3, 18)
print("SEEDED " + json.dumps({"monday": monday.isoformat()}))
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
    await page.waitForSelector(".calendar-grid .calendar-event[data-event-id]");
}

function event_selector(title: string, date: string): string {
    return `.calendar-day-column[data-date="${date}"] .calendar-event[aria-label^="${title},"]`;
}

async function open_card(page: Page, title: string, date: string): Promise<void> {
    await page.click(event_selector(title, date));
    await page.waitForSelector(".calendar-card", {visible: true});
}

async function card_facts(page: Page): Promise<Record<string, unknown>> {
    return await page.$eval(".calendar-card", (card) => ({
        title: card.querySelector(".calendar-card-title")!.textContent.trim(),
        time: card.querySelector(".calendar-card-time")!.textContent.trim(),
        series: card.querySelector(".calendar-card-series") !== null,
        location: card.querySelector(".calendar-card-location")?.textContent.trim(),
        organizer: card.querySelector(".calendar-card-organizer-text span")?.textContent.trim(),
        counts: card.querySelector(".calendar-card-counts")?.textContent.trim(),
        buttons: [...card.querySelectorAll(".calendar-card-actions button")].map((button) =>
            button.textContent.trim(),
        ),
        notify_disabled:
            card.querySelector<HTMLInputElement>(".calendar-card-message")?.disabled ?? null,
    }));
}

async function choose(page: Page, label: string): Promise<void> {
    await page.waitForSelector(".calendar-card-choices", {visible: true});
    await page.evaluate((label) => {
        const choices = [...document.querySelectorAll<HTMLElement>(".calendar-card-choice")];
        choices.find((choice) => choice.textContent.trim() === label)!.click();
    }, label);
}

async function close_card(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".calendar-card", {hidden: true});
}

function add_days(date: string, days: number): string {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

async function calendar_card_test(page: Page): Promise<void> {
    const {monday} = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as {
        monday: string;
    };
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    const week_hash = `#calendar/workweek/${monday}`;
    await open_week(page, week_hash);

    // An invitation.
    await open_card(page, "Review", monday);
    let facts = await card_facts(page);
    check(
        "an invitation shows its time, place, organizer and answers",
        facts["title"] === "Review" &&
            /^Mon \d\d\/\d\d\/\d{4} 12:00 PM – 1:00 PM$/.test(String(facts["time"])) &&
            facts["series"] === true &&
            facts["location"] === "Room 4" &&
            facts["organizer"] === "Othello, the Moor of Venice invited you" &&
            facts["counts"] === "Accepted: 1 · Not answered: 1" &&
            facts["notify_disabled"] === false,
        JSON.stringify(facts),
    );
    await shot(page, "dark-invitation");

    // Accepting one occurrence of a series.
    await page.click('.calendar-card-respond[data-response="accepted"]');
    await choose(page, "This occurrence");
    await page.waitForSelector('.calendar-card-respond[data-response="accepted"].selected');
    check("accepting marks the answer in the card", true);
    await page.waitForFunction(
        (selector) => {
            const label = document.querySelector(selector)?.getAttribute("aria-label");
            return label !== undefined && label !== null && !label.endsWith("Tentative");
        },
        {polling: 100},
        event_selector("Review", monday),
    );
    await close_card(page);

    // From the keyboard, Escape returns to the event. The answer draws
    // the grid again, once for the request and once for the event that
    // the server sends, so the event is focused after that.
    await page.waitForNetworkIdle({idleTime: 500, concurrency: 1});
    await page.focus(event_selector("Review", monday));
    await page.keyboard.press("Enter");
    await page.waitForSelector(".calendar-card", {visible: true});
    await close_card(page);
    const focused = await page
        .waitForFunction(
            () =>
                document.activeElement?.classList.contains("calendar-event") === true &&
                document.activeElement.getAttribute("aria-label")!.startsWith("Review,"),
            {polling: 100, timeout: 2000},
        )
        .then(
            () => true,
            () => false,
        );
    check("closing the card returns to the event", focused);

    // Tentative for the whole series, from another day.
    const tuesday = add_days(monday, 1);
    await open_card(page, "Review", tuesday);
    await page.click('.calendar-card-respond[data-response="tentative"]');
    await page.waitForSelector('.calendar-card-respond[data-response="tentative"].selected');
    await close_card(page);
    await page.waitForFunction(
        (selector) => document.querySelector(selector)?.classList.contains("tentative") === true,
        {polling: 100},
        event_selector("Review", add_days(monday, 2)),
    );
    check(
        "a tentative answer to the series marks every occurrence but the accepted one",
        !(await page.$eval(event_selector("Review", monday), (event) =>
            event.classList.contains("tentative"),
        )),
    );

    // Following from the … menu.
    await open_card(page, "Review", tuesday);
    await page.click(".calendar-card-more");
    await choose(page, "Follow meeting");
    await page.waitForFunction(
        (selector) => document.querySelector(selector)?.classList.contains("free") === true,
        {polling: 100},
        event_selector("Review", add_days(monday, 2)),
    );
    check("following shows the meeting as free", true);
    await close_card(page);

    // The organizer of a series with a Zulip call.
    await open_card(page, "Planning", tuesday);
    facts = await card_facts(page);
    check(
        "the organizer sees edit and cancel, and the Zulip call as the place",
        facts["organizer"] === "You are the organizer" &&
            facts["location"] === "Zulip call" &&
            JSON.stringify(facts["buttons"]) === JSON.stringify(["Edit", "Cancel meeting"]) &&
            (await page.$(".calendar-card-meeting-icon")) !== null,
        JSON.stringify(facts),
    );
    await shot(page, "dark-organizer");
    await page.click(".calendar-card-cancel");
    await choose(page, "This occurrence");
    await common.wait_for_micromodal_to_open(page);
    await shot(page, "dark-cancel-confirm");
    await page.click(".micromodal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForFunction(
        (selector) => document.querySelector(selector) === null,
        {polling: 100},
        event_selector("Planning", tuesday),
    );
    check("canceling an occurrence removes it from the grid", true);

    // A personal event is deleted after confirming.
    const thursday = add_days(monday, 3);
    await open_card(page, "Gym", thursday);
    facts = await card_facts(page);
    check(
        "a personal event has edit and delete, and no organizer line",
        JSON.stringify(facts["buttons"]) === JSON.stringify(["Edit", "Delete"]) &&
            facts["organizer"] === undefined,
        JSON.stringify(facts),
    );
    await page.click(".calendar-card-cancel");
    await common.wait_for_micromodal_to_open(page);
    await page.click(".micromodal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForFunction(
        (selector) => document.querySelector(selector) === null,
        {polling: 100},
        event_selector("Gym", thursday),
    );
    check("deleting a personal event removes it", true);

    // A card near the right edge opens inside the window.
    await open_card(page, "Single", add_days(monday, 2));
    await close_card(page);
    await page.setViewport({width: 1024, height: 768});
    await open_week(page, `#calendar/week/${monday}`);
    await page.evaluate(() => {
        document.querySelector(".calendar-grid-container")!.scrollLeft = 10_000;
    });
    await open_card(page, "Review", add_days(monday, 6));
    const inside = await page.$eval(".calendar-card", (card) => {
        const rect = card.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
    });
    check("a card near the edge opens inside the window", inside);

    // Light theme, in Russian.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await page.setViewport({width: 1440, height: 900});
    await open_week(page, week_hash);
    await open_card(page, "Review", monday);
    await shot(page, "light-ru-invitation");
    await close_card(page);
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_card_test);
