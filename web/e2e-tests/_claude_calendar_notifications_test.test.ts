import {execSync} from "node:child_process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "calendar-notifications";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import timedelta

from django.conf import settings
from django.utils.timezone import now as timezone_now

from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.calendar.changes import (
    create_calendar_event,
    respond_to_calendar_event,
    update_calendar_event,
)
from zerver.models import CalendarEvent, Message
from zerver.models.calendar import CalendarResponse
from zerver.models.realms import get_realm
from zerver.models.users import get_system_bot, get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)


desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
bot = get_system_bot(settings.NOTIFICATION_BOT, realm.id)


def last_notification(user):
    return Message.objects.filter(sender=bot, usermessage__user_profile=user).latest("id").content
`;

// Othello invites Desdemona to a standup in ten minutes, with a Zulip
// call; Desdemona's planning meeting tomorrow, which Othello accepts.
const seed_script =
    python_prelude +
    String.raw`
do_change_user_setting(desdemona, "timezone", "Europe/Moscow", acting_user=None)
start = timezone_now().replace(second=0, microsecond=0) + timedelta(minutes=10)
standup_id = create_calendar_event(
    othello,
    title="Standup",
    start=start,
    end=start + timedelta(minutes=30),
    event_timezone="Europe/Moscow",
    required_attendees=[desdemona],
    optional_attendees=[],
    has_zulip_call=True,
)
planning_id = create_calendar_event(
    desdemona,
    title="Planning",
    start=start + timedelta(days=1),
    end=start + timedelta(days=1, hours=1),
    event_timezone="Europe/Moscow",
    required_attendees=[othello],
    optional_attendees=[],
)
respond_to_calendar_event(othello, planning_id, CalendarResponse.ACCEPTED, message="See you there")
print("SEEDED " + json.dumps({"standup_id": standup_id, "bot_id": bot.id, "start": int(start.timestamp())}))
`;

type Seeded = {standup_id: number; bot_id: number; start: number};

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

const reminder = ".calendar-reminder-banner";

// The text of Notification Bot's last direct message that contains
// the text.
async function open_notification(page: Page, bot_id: number, containing: string): Promise<string> {
    await page.goto(`${base_url}#narrow/dm/${bot_id}-Notification-Bot`);
    await page.waitForFunction(
        (containing) =>
            [...document.querySelectorAll(".message_content")].some((element) =>
                element.textContent.includes(containing),
            ),
        {},
        containing,
    );
    return await page.evaluate((containing) => {
        const messages = [...document.querySelectorAll(".message_content")].filter((element) =>
            element.textContent.includes(containing),
        );
        return messages.at(-1)!.textContent.trim().replaceAll(/\s+/g, " ");
    }, containing);
}

async function click_calendar_link(page: Page, containing: string): Promise<void> {
    await page.evaluate((containing) => {
        const messages = [...document.querySelectorAll(".message_content")].filter((element) =>
            element.textContent.includes(containing),
        );
        messages.at(-1)!.querySelector<HTMLAnchorElement>('a[href*="#calendar/event/"]')!.click();
    }, containing);
}

async function calendar_notifications_test(page: Page): Promise<void> {
    const {standup_id, bot_id} = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;
    await common.log_in(page);
    await page.setViewport({width: 1440, height: 900});
    await request(page, "PATCH", "/json/realm", "video_chat_provider=10");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=14");
    await page.reload();

    // The standup reminds of itself, ten minutes ahead.
    await page.waitForSelector(reminder, {visible: true});
    const label = await text(page, `${reminder} .banner-label`);
    check(
        "the meeting reminds of itself",
        /^Standup starts in (9|10) minutes\.$/.test(label) &&
            (await page.$(`${reminder} .calendar-reminder-join`)) !== null,
        label,
    );
    await shot(page, "reminder-dark");

    // Notification Bot invited Desdemona, with a link to the meeting.
    const invitation = await open_notification(page, bot_id, "invited you to");
    check(
        "Notification Bot sends the invitation",
        /^Othello, the Moor of Venice invited you to Standup on .+\. Open in calendar$/.test(
            invitation,
        ),
        invitation,
    );
    await shot(page, "invitation-dark");
    await click_calendar_link(page, "invited you to");
    await page.waitForSelector(".calendar-meeting", {visible: true});
    check(
        "its link opens the meeting",
        (await text(page, ".calendar-meeting-title")) === "Standup",
    );
    await page.click(".calendar-meeting-close");

    // Accepting from the card tells Othello, with a message.
    await page.click(`.calendar-event[data-event-id="${standup_id}"]`);
    await page.waitForSelector(".calendar-card", {visible: true});
    await page.type(".calendar-card-message", "Running late");
    await shot(page, "card-notify-dark");
    await page.click('.calendar-card-respond[data-response="accepted"]');
    await page.waitForSelector('.calendar-card-respond[data-response="accepted"].selected');
    const response = run_python(
        python_prelude + `print("LAST " + json.dumps(last_notification(othello)))`,
    ).split("LAST ")[1]!;
    check(
        "the organizer learns the response and its message",
        JSON.parse(response).includes("accepted **Standup**.") &&
            JSON.parse(response).includes("> Running late"),
        response.trim(),
    );
    await page.keyboard.press("Escape");

    // As the organizer, Desdemona learns that Othello accepted, and the
    // link opens the meeting to change it, next to the responses.
    const accepted = await open_notification(page, bot_id, "accepted Planning");
    check(
        "the organizer's notification quotes the message",
        accepted.startsWith("Othello, the Moor of Venice accepted Planning. See you there"),
        accepted,
    );
    await click_calendar_link(page, "accepted Planning");
    await page.waitForSelector(".calendar-form .calendar-responses:not(.hide)", {visible: true});
    check(
        "the organizer's link opens the meeting with the responses",
        (await page.$eval(
            ".calendar-form-title",
            (element) => (element as HTMLInputElement).value,
        )) === "Planning",
    );

    // A closed reminder stays closed.
    await page.goto(`${base_url}#inbox`);
    await page.waitForSelector(reminder, {visible: true});
    await page.click(`${reminder} .calendar-reminder-close`);
    await page.waitForSelector(reminder, {hidden: true});
    await page.reload();
    await page.waitForSelector("#inbox-main", {visible: true});
    await new Promise((resolve) => setTimeout(resolve, 2000));
    check("a closed reminder stays closed", (await page.$(reminder)) === null);

    // Moving the meeting reminds of it again, at its new time.
    run_python(
        python_prelude +
            String.raw`
event = CalendarEvent.objects.get(id=${standup_id})
update_calendar_event(othello, event.id, start=event.start + timedelta(minutes=5))
print("MOVED " + json.dumps(last_notification(desdemona)))
`,
    );
    await page.waitForSelector(reminder, {visible: true});
    const moved_label = await text(page, `${reminder} .banner-label`);
    check(
        "a moved meeting reminds again",
        /^Standup starts in 1[45] minutes\.$/.test(moved_label),
        moved_label,
    );
    const moved = await open_notification(page, bot_id, "moved Standup");
    check(
        "Notification Bot tells of the move",
        /^Othello, the Moor of Venice moved Standup to .+\. Open in calendar$/.test(moved),
        moved,
    );

    // In Russian, and in the light theme.
    await request(page, "PATCH", "/json/settings", "color_scheme=3&default_language=ru");
    run_python(
        python_prelude +
            String.raw`
update_calendar_event(othello, ${standup_id}, start=CalendarEvent.objects.get(id=${standup_id}).start - timedelta(minutes=1))
`,
    );
    const moved_ru = await open_notification(page, bot_id, "переносит встречу");
    check(
        "Notification Bot writes in the recipient's language",
        moved_ru.startsWith("Othello, the Moor of Venice переносит встречу Standup на ") &&
            moved_ru.endsWith("Открыть в календаре"),
        moved_ru,
    );
    await page.reload();
    await page.waitForSelector(reminder, {visible: true});
    const label_ru = await text(page, `${reminder} .banner-label`);
    check(
        "the reminder is in Russian",
        /^Standup: начало через 1[34] минут[ы]?\.$/.test(label_ru) &&
            (await text(page, `${reminder} .calendar-reminder-join`)) === "Подключиться",
        label_ru,
    );
    await shot(page, "reminder-light-ru");
    await request(page, "PATCH", "/json/settings", "color_scheme=2&default_language=en");
    await request(page, "PATCH", "/json/realm", "video_chat_provider=1");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(calendar_notifications_test);
