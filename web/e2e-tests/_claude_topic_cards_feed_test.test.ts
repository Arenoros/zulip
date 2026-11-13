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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "topic-cards";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import datetime, timedelta, timezone

from zerver.actions.message_send import internal_send_stream_message
from zerver.models import Message, UserMessage
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
cordelia = get_user_by_delivery_email("cordelia@zulip.com", realm)
`;

// A channel whose oldest topic has unread replies for Desdemona, then
// enough one-message topics to push it out of view, and a topic with
// hidden replies at the bottom.
const seed_script =
    python_prelude +
    String.raw`
from django.db.models import F

from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed

stream, _ = create_stream_if_needed(realm, "roadmap", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, iago, hamlet, othello, cordelia], acting_user=None)
start = datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
minutes = 0


def send(sender, topic, content):
    global minutes
    minutes += 5
    message_id = internal_send_stream_message(sender, stream, topic, content)
    Message.objects.filter(id=message_id).update(date_sent=start + timedelta(minutes=minutes))
    return message_id


ids = {}
ids["unread"] = [send(hamlet, "unread news", "Please read this.")]
ids["unread"] += [send(othello, "unread news", f"Unread reply {i}.") for i in range(1, 6)]
for i in range(1, 13):
    ids[f"filler {i:02}"] = [send(iago, f"filler {i:02}", f"Filler topic number {i}.")]
ids["talk"] = [send(desdemona, "release talk", "When do we ship?")]
for sender, content in [
    (iago, "Friday."),
    (hamlet, "Can we make it Thursday?"),
    (othello, "Thursday works for me."),
    (cordelia, "Then Thursday."),
    (iago, "I will prepare the notes."),
    (hamlet, "Great."),
    (othello, "See you then."),
]:
    ids["talk"].append(send(sender, "release talk", content))

# Desdemona has read everything except the oldest topic.
unread_ids = ids["unread"]
UserMessage.objects.filter(user_profile=desdemona, message__recipient=stream.recipient).exclude(
    message_id__in=unread_ids
).update(flags=F("flags").bitor(UserMessage.flags.read))
UserMessage.objects.filter(user_profile=desdemona, message_id__in=unread_ids).update(
    flags=F("flags").bitand(~UserMessage.flags.read)
)

print("SEEDED " + json.dumps({"ids": ids, "stream_id": stream.id}))
`;

type Seeded = {ids: Record<string, number[]>; stream_id: number};

async function set_setting(page: Page, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(async (body) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                ?.value ?? "";
        const response = await fetch("/json/settings", {
            method: "PATCH",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-CSRFToken": csrf_token,
            },
            body,
        });
        return response.status;
    }, body);
    if (status !== 200) {
        throw new Error(`PATCH /json/settings ${body}: ${status}`);
    }
}

async function card_titles(page: Page): Promise<string[]> {
    return await page.$$eval(".focused-message-list .topic-card-title-text", (titles) =>
        titles.map((title) => title.textContent.trim()),
    );
}

async function card_rows(page: Page, title: string): Promise<number[]> {
    return await page.evaluate((title) => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === title,
        );
        return [...(card?.querySelectorAll<HTMLElement>(".message_row") ?? [])].map((row) =>
            Number(row.dataset["messageId"]),
        );
    }, title);
}

// Waits until the feed stops scrolling, since Zulip animates some
// scrolling.
async function wait_for_scroll_to_settle(page: Page): Promise<void> {
    let last = -1;
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const current = await page.evaluate(() => window.scrollY);
        if (current === last) {
            return;
        }
        last = current;
    }
}

function row(id: number): string {
    return `.focused-message-list .message_row[data-message-id="${id}"]`;
}

async function selected_id(page: Page): Promise<number> {
    return await page.evaluate(() =>
        Number(
            document.querySelector<HTMLElement>(".focused-message-list .selected_message")
                ?.dataset["messageId"],
        ),
    );
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!.getBoundingClientRect();
        return {
            x: list.left + window.scrollX,
            y: window.scrollY,
            width: list.width,
            height: window.innerHeight,
        };
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function topic_cards_feed_test(page: Page): Promise<void> {
    const output = run_python(seed_script);
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    const {ids} = seeded;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await set_setting(
        page,
        "web_channel_default_view=5&color_scheme=3&twenty_four_hour_time=true&web_font_size_px=15&timezone=UTC",
    );
    await page.goto(`${base_url}#conversations/channel/${seeded.stream_id}`);
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Unread messages above the visible cards.
    const unread_above = await page.$eval(".topic-cards-unread-above", (button) => ({
        shown: button.classList.contains("show"),
        text: button.textContent.trim(),
    }));
    check(
        "a button points to cards with unread messages above",
        unread_above.shown && unread_above.text === "1 conversation with unread messages",
        JSON.stringify(unread_above),
    );
    const unread_card = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === "unread news",
        )!;
        return {
            marked: card.classList.contains("topic-card-unread"),
            count: card.querySelector(".topic-card-unread-count")?.textContent.trim(),
        };
    });
    check(
        "a card with unread messages is marked and counts them",
        unread_card.marked && unread_card.count === "6",
        JSON.stringify(unread_card),
    );
    await shot(page, "unread-above");
    await page.click(".topic-cards-unread-above-button");
    await page.waitForFunction(
        (selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight;
        },
        {},
        row(ids["unread"]![0]!),
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after_reading = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === "unread news",
        )!;
        return card.querySelector(".topic-card-unread-count")?.textContent.trim();
    });
    // The first message and the three latest replies are read; the
    // two replies the card leaves out are not.
    check(
        "messages shown in a card get read, hidden replies stay unread",
        after_reading === "2",
        String(after_reading),
    );

    // Moving with the arrow keys follows the cards on screen.
    const talk = await card_rows(page, "release talk");
    await page.click(`${row(talk[0]!)} .message_content`);
    await page.keyboard.press("Escape");
    const filler = await card_rows(page, "filler 12");
    await page.keyboard.press("ArrowUp");
    let selected = await selected_id(page);
    check(
        "the up arrow goes to the last message of the card above",
        selected === filler.at(-1),
        `${selected} ${filler.at(-1)}`,
    );
    await page.keyboard.press("KeyJ");
    await page.keyboard.press("KeyJ");
    selected = await selected_id(page);
    check(
        "j goes down through a card's messages",
        selected === talk[1],
        `${selected} ${talk[1]}`,
    );

    // Full message actions inside a card.
    await page.keyboard.type("+");
    await page.waitForSelector(`${row(talk[1]!)} .message_reaction`, {visible: true});
    check("a reaction can be added to a reply in a card", true);
    await page.click(`${row(talk[1]!)} .message_content`, {button: "right"});
    await page.waitForSelector("#message-actions-menu-dropdown", {visible: true});
    check("right-clicking a reply opens the message menu", true);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#message-actions-menu-dropdown", {hidden: true});

    // Hidden replies open in the card and collapse again.
    await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) =>
                card.querySelector(".topic-card-title-text")?.textContent.trim() === "release talk",
        )!;
        card.querySelector<HTMLElement>(".topic-card-hidden-replies-label")!.click();
    });
    await page.waitForFunction(
        (title: string) =>
            [...document.querySelectorAll(".focused-message-list .recipient_row")]
                .find(
                    (card) =>
                        card.querySelector(".topic-card-title-text")?.textContent.trim() === title,
                )
                ?.querySelectorAll(".message_row").length === 8,
        {},
        "release talk",
    );
    const opened = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) =>
                card.querySelector(".topic-card-title-text")?.textContent.trim() === "release talk",
        )!;
        return {
            collapse: card.querySelector(".topic-card-collapse") !== null,
            label: card.querySelector(".topic-card-hidden-replies-label") !== null,
        };
    });
    check(
        "opening hidden replies shows them all, with a way to collapse",
        opened.collapse && !opened.label,
        JSON.stringify(opened),
    );
    await shot(page, "expanded");
    await page.click(".focused-message-list .topic-card-collapse");
    await page.waitForFunction(
        () => document.querySelector(".focused-message-list .topic-card-collapse") === null,
    );
    check(
        "collapsing shows the latest replies again",
        (await card_rows(page, "release talk")).length === 4,
    );

    // Replying from a card above keeps the user in the view, and the
    // card moves to the bottom.
    const filler_card = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === "filler 05",
        )!;
        card.scrollIntoView({block: "center"});
        return true;
    });
    assert_ok(filler_card);
    await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === "filler 05",
        )!;
        card.querySelector<HTMLElement>(".topic-card-reply-button")!.click();
    });
    await page.waitForSelector("#compose-textarea", {visible: true});
    const topic_in_compose = await page.$eval(
        "#stream_message_recipient_topic",
        (input) => (input as HTMLInputElement).value,
    );
    check(
        "Reply in topic opens the compose box for that topic",
        topic_in_compose === "filler 05",
        topic_in_compose,
    );
    await page.type("#compose-textarea", "A reply from the card.");
    await page.click("#compose-send-button");
    // Wait for the server to confirm the reply, which replaces its
    // local ID.
    await page.waitForFunction(() => {
        const cards = [...document.querySelectorAll(".focused-message-list .recipient_row")];
        const last_card = cards.at(-1);
        const last_row = [...(last_card?.querySelectorAll<HTMLElement>(".message_row") ?? [])].at(-1);
        return (
            last_card?.querySelector(".topic-card-title-text")?.textContent.trim() ===
                "filler 05" &&
            last_row?.textContent.includes("A reply from the card.") === true &&
            Number.isInteger(Number(last_row.dataset["messageId"]))
        );
    });
    await wait_for_scroll_to_settle(page);
    const own_reply_id = (await card_rows(page, "filler 05")).at(-1)!;
    const after_reply = await page.evaluate(
        (selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return {
                hash: window.location.hash,
                visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
            };
        },
        row(own_reply_id),
    );
    check(
        "a reply moves its card to the bottom and the view follows it",
        after_reply.hash.startsWith("#conversations/") && after_reply.visible,
        JSON.stringify(after_reply),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector("#compose-textarea", {hidden: true});
    await wait_for_scroll_to_settle(page);

    // A reply from someone else while reading above.
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const reading_above = await page.evaluate(() => window.scrollY);
    check("the user reads the top of the view", reading_above < 200, String(reading_above));
    run_python(
        python_prelude +
            String.raw`
stream = get_stream("roadmap", realm)
internal_send_stream_message(hamlet, stream, "filler 02", "A late reply.")
`,
    );
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".focused-message-list .topic-card-title-text")]
                .at(-1)
                ?.textContent.trim() === "filler 02",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const late = await page.evaluate(() => ({
        scroll_top: document.documentElement.scrollTop,
        button: document.querySelector("#topic-cards-new-replies")!.classList.contains("show"),
    }));
    check(
        "a new reply while reading above moves its card without scrolling, and offers to go there",
        late.scroll_top < 200 && late.button,
        JSON.stringify(late),
    );
    await shot(page, "new-replies");
    await page.click(".topic-cards-new-replies-button");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const followed = await page.evaluate(() => ({
        at_bottom:
            document.documentElement.scrollHeight -
                document.documentElement.scrollTop -
                window.innerHeight <
            400,
        button: document.querySelector("#topic-cards-new-replies")!.classList.contains("show"),
    }));
    check(
        "the new replies button goes to the bottom and hides",
        followed.at_bottom && !followed.button,
        JSON.stringify(followed),
    );

    // Live changes: an edit, a resolved topic, a muted topic.
    run_python(
        python_prelude +
            String.raw`
from zerver.actions.message_edit import check_update_message
from zerver.actions.user_topics import do_set_user_topic_visibility_policy
from zerver.models import UserTopic

stream = get_stream("roadmap", realm)
check_update_message(desdemona, ${own_reply_id}, content="A reply from the card. Edited.")
first = Message.objects.filter(recipient=stream.recipient, subject="filler 01").first()
check_update_message(iago, first.id, topic_name="✔ filler 01", propagate_mode="change_all")
do_set_user_topic_visibility_policy(
    desdemona, stream, "filler 03", visibility_policy=UserTopic.VisibilityPolicy.MUTED
)
`,
    );
    await page.waitForFunction(
        (selector: string) =>
            document.querySelector(selector)?.textContent.includes("Edited.") ?? false,
        {},
        `${row(own_reply_id)} .message_content`,
    );
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".focused-message-list .recipient_row")].some(
            (card) =>
                card.querySelector(".topic-card-title-text")?.textContent.trim() === "filler 01" &&
                card.querySelector(".topic-card-resolved-label") !== null,
        ),
    );
    await page.waitForFunction(
        () =>
            ![...document.querySelectorAll(".focused-message-list .topic-card-title-text")].some(
                (title) => title.textContent.trim() === "filler 03",
            ),
    );
    const titles = await card_titles(page);
    check(
        "edits, resolving and muting update the cards live",
        titles.includes("release talk") && titles.includes("filler 01"),
        JSON.stringify(titles),
    );

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

function assert_ok(value: boolean): void {
    if (!value) {
        throw new Error("assertion failed");
    }
}

await common.run_test(topic_cards_feed_test);
