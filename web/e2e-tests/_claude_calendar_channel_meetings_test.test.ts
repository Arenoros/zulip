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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-channel-meetings";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from zerver.actions.message_flags import do_mark_all_as_read
from zerver.actions.streams import bulk_add_subscriptions
from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import create_calendar_event
from zerver.lib.topic import messages_for_topic
from zerver.models import CalendarEvent
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)


desdemona = user("desdemona@zulip.com")
iago = user("iago@zulip.com")
cordelia = user("cordelia@zulip.com")
verona = get_stream("Verona", realm)
denmark = get_stream("Denmark", realm)
MOSCOW = ZoneInfo("Europe/Moscow")
`;

// Iago scheduled a meeting next Tuesday at 10:00 in Moscow in Verona,
// which Desdemona is subscribed to, without inviting her.
const seed_script =
    python_prelude +
    String.raw`
for person in [desdemona, iago, cordelia]:
    do_change_user_setting(person, "timezone", "Europe/Moscow", acting_user=None)
bulk_add_subscriptions(realm, [verona, denmark], [desdemona, iago], acting_user=None)
today = datetime.now(MOSCOW).date()
monday = today - timedelta(days=today.weekday()) + timedelta(days=7)
start = datetime(monday.year, monday.month, monday.day, 10, tzinfo=MOSCOW) + timedelta(days=1)
create_calendar_event(
    iago,
    title="Channel sync",
    start=start,
    end=start + timedelta(minutes=30),
    event_timezone="Europe/Moscow",
    required_attendees=[cordelia],
    optional_attendees=[],
    channel=verona,
)
do_mark_all_as_read(desdemona)
print("SEEDED " + json.dumps({"monday": monday.isoformat(), "verona_id": verona.id}))
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

// The JSON that a script printed after the marker.
function get_printed(output: string, marker: string): unknown {
    return JSON.parse(output.slice(output.indexOf(marker) + marker.length));
}

function get_created_meeting(title: string): {channel: string; topic: string; posts: string[]} {
    const output = run_python(
        python_prelude +
            String.raw`
event = CalendarEvent.objects.filter(title=${JSON.stringify(title)}).latest("id")
posts = [m.content.split(" [")[0] for m in messages_for_topic(realm.id, event.channel.recipient_id, event.topic)]
print("CREATED " + json.dumps({"channel": event.channel.name, "topic": event.topic, "posts": posts}))
`,
    );
    return z
        .object({channel: z.string(), topic: z.string(), posts: z.array(z.string())})
        .parse(get_printed(output, "CREATED "));
}

function unsubscribe_from_verona(): void {
    run_python(
        python_prelude +
            String.raw`
from zerver.actions.streams import bulk_remove_subscriptions
bulk_remove_subscriptions(realm, [desdemona], [verona], acting_user=None)
`,
    );
}

const meeting_selector = '.calendar-event[aria-label^="Channel sync,"]';

async function open_week(page: Page, monday: string): Promise<void> {
    await page.goto(`${base_url}#calendar/week/${monday}`);
    await page.reload();
    await page.waitForSelector(".calendar-grid .calendar-day-column", {visible: true});
    await page.waitForNetworkIdle({idleTime: 300, concurrency: 1});
}

async function set_channel_meetings_shown(page: Page, shown: boolean): Promise<void> {
    await page.click(".calendar-filter-menu-trigger button");
    await page.waitForSelector("#calendar-filter-menu", {visible: true});
    const option = '.calendar-filter-option[data-filter-option="channel_meetings"]';
    const checked = await page.$eval(option, (item) => item.getAttribute("aria-checked"));
    if ((checked === "true") !== shown) {
        await page.click(option);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#calendar-filter-menu") === null);
}

async function calendar_channel_meetings_test(page: Page): Promise<void> {
    const {monday, verona_id} = z
        .object({monday: z.string(), verona_id: z.number()})
        .parse(get_printed(run_python(seed_script), "SEEDED "));
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");

    // Subscribers see the meetings of their channels without an
    // invitation.
    await open_week(page, monday);
    check(
        "a subscriber sees a meeting of their channel",
        (await page.$(meeting_selector)) !== null,
    );
    await page.click(meeting_selector);
    await page.waitForSelector(".calendar-card", {visible: true});
    const channel = (await texts(page, ".calendar-card-channel"))[0];
    const organizer = (await texts(page, ".calendar-card-organizer-text span"))[0];
    check(
        "the card shows the channel and topic, and who organized it",
        channel === "#Verona > Channel sync" && organizer === "Organized by Iago",
        `${channel} | ${organizer}`,
    );
    check(
        "a subscriber who was not invited does not respond, but can discuss",
        (await page.$(".calendar-card-actions")) === null &&
            (await page.$(".calendar-card-chat")) !== null,
    );
    await shot(page, "card-dark");

    // The opened meeting offers the same.
    await page.click(".calendar-card-expand");
    await page.waitForSelector(".calendar-meeting", {visible: true});
    check(
        "the opened meeting shows the channel, without responses or personal menus",
        (await texts(page, ".calendar-meeting-channel"))[0] === "#Verona > Channel sync" &&
            (await page.$(".calendar-meeting-respond")) === null &&
            (await page.$(".calendar-meeting-menu-button")) === null &&
            (await page.$(".calendar-responses-own")) === null &&
            (await page.$(".calendar-meeting-chat")) !== null,
    );
    await shot(page, "meeting-dark");

    // Discussion opens the meeting's topic of the channel.
    await page.click(".calendar-meeting-chat");
    await page.waitForFunction(
        (verona_id: number) =>
            window.location.hash.startsWith(`#narrow/channel/${verona_id}-`) &&
            window.location.hash.endsWith("/topic/Channel.20sync"),
        {},
        verona_id,
    );
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    const announcement = await texts(page, ".focused-message-list .message_content");
    check(
        "the topic has Notification Bot's announcement of the meeting",
        announcement.some((text) => text.startsWith("Iago scheduled Channel sync on")),
        JSON.stringify(announcement),
    );

    // The filter hides the meetings of channels without an invitation.
    await open_week(page, monday);
    await set_channel_meetings_shown(page, false);
    await page.waitForSelector(meeting_selector, {hidden: true});
    check("the filter hides the meetings in channels", true);
    await set_channel_meetings_shown(page, true);
    await page.waitForSelector(meeting_selector, {visible: true});
    check("and shows them again", true);

    // Scheduling a meeting in a channel.
    await page.click(".calendar-new-menu-trigger button");
    await page.waitForSelector('.calendar-card-choice[data-choice="channel_meeting"]', {
        visible: true,
    });
    await page.click('.calendar-card-choice[data-choice="channel_meeting"]');
    await page.waitForSelector(".calendar-form-channel", {visible: true});
    check(
        "the form of a meeting in a channel has no visibility menu",
        (await page.$('.calendar-form-menu-button[data-menu="visibility"]')) === null &&
            (await texts(page, ".calendar-form-event-button"))[0] === "Meeting in a channel",
    );
    await page.type(".calendar-form-title", "Release review");
    await page.click(".calendar-form-save");
    await page.waitForSelector(".calendar-form-channel-error.shown", {visible: true});
    check(
        "a channel must be chosen",
        (await texts(page, ".calendar-form-channel-error"))[0] === "Choose a channel.",
    );
    await page.click(".calendar-form-channel");
    await page.waitForSelector(".dropdown-list-search-input", {visible: true});
    await page.type(".dropdown-list-search-input", "Denmark");
    await page.waitForSelector(".dropdown-list-item-common-styles", {visible: true});
    await page.click(".dropdown-list-item-common-styles");
    await page.waitForFunction(
        () =>
            document.querySelector(".calendar-form-channel-name")?.textContent.trim() === "Denmark",
    );
    await shot(page, "form-dark");
    await page.click(".calendar-form-save");
    await page.waitForSelector(".calendar-form", {hidden: true});
    const created = get_created_meeting("Release review");
    check(
        "the meeting is saved in the channel, and announced in its topic",
        created.channel === "Denmark" &&
            created.topic === "Release review" &&
            created.posts.length === 1 &&
            created.posts[0]!.includes("scheduled **Release review** on"),
        JSON.stringify(created),
    );

    // Leaving the channel hides its meetings.
    await open_week(page, monday);
    unsubscribe_from_verona();
    await page.waitForSelector(meeting_selector, {hidden: true});
    check("leaving a channel hides its meetings", true);

    // In Russian, and in the light theme.
    run_python(
        python_prelude + "bulk_add_subscriptions(realm, [verona], [desdemona], acting_user=None)\n",
    );
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    await open_week(page, monday);
    await page.click(meeting_selector);
    await page.waitForSelector(".calendar-card", {visible: true});
    const russian = (await texts(page, ".calendar-card-organizer-text span"))[0];
    check("the card is in Russian", russian === "Организатор: Iago", russian);
    await shot(page, "card-light-ru");
    await page.keyboard.press("Escape");
    await page.click(".calendar-new-menu-trigger button");
    const choices = await texts(page, ".calendar-card-choice");
    check(
        "the create menu is in Russian",
        choices.includes("Встреча в канале"),
        JSON.stringify(choices),
    );
    await page.keyboard.press("Escape");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_channel_meetings_test);
