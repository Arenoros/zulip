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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "reply-in-conversations";

const seed_script = String.raw`import json

from zerver.actions.message_send import internal_send_stream_message
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
stream, _ = create_stream_if_needed(realm, "pantry", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, hamlet], acting_user=None)
for topic in ["coffee", "a really long topic that will not fit in the line above it", "fridge"]:
    internal_send_stream_message(hamlet, stream, topic, f"About the {topic}.")
print("SEEDED " + json.dumps({"stream_id": stream.id}))
`;

async function set_setting(page: Page, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(async (body) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')?.value ??
            "";
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

async function open_conversations(page: Page, stream_id: number): Promise<void> {
    await page.goto(`${base_url}#conversations/channel/${stream_id}-pantry`);
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await page.mouse.move(1, 1);
}

async function click_reply_in_topic(page: Page, topic: string): Promise<void> {
    await page.evaluate((topic) => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === topic,
        )!;
        card.querySelector<HTMLElement>(".topic-card-reply-button")!.click();
    }, topic);
    await page.waitForSelector("#compose.compose-reply-in-conversations", {visible: true});
}

type ReplyFacts = {
    open: boolean;
    reply: boolean;
    row_layout: boolean;
    line: string;
    line_shown: boolean;
    line_truncated: boolean;
    recipient_row_shown: boolean;
    close_shown: boolean;
    new_conversation_shown: boolean;
    focused: boolean;
    topic: string;
    field_height: number;
    overflowing: number;
};

async function reply_facts(page: Page): Promise<ReplyFacts> {
    return await page.evaluate(() => {
        const compose = document.querySelector("#compose")!;
        const shown = (selector: string): boolean => {
            const element = document.querySelector<HTMLElement>(selector);
            return element !== null && element.offsetParent !== null;
        };
        const line = document.querySelector("#compose-reply-line-text")!;
        const field = document.querySelector("#compose .messagebox")!.getBoundingClientRect();
        return {
            open: compose.classList.contains("compose-box-open"),
            reply: compose.classList.contains("compose-reply-in-conversations"),
            row_layout: compose.classList.contains("compose-row-layout"),
            line: line.textContent.trim(),
            line_shown: shown("#compose-reply-line"),
            line_truncated: line.scrollWidth > line.clientWidth,
            recipient_row_shown: shown("#compose-recipient"),
            close_shown: shown("#compose_close"),
            new_conversation_shown: shown(
                "#legacy-closed-compose-box .topic-cards-new-conversation-button",
            ),
            focused: document.activeElement === document.querySelector("#compose-textarea"),
            topic: document.querySelector<HTMLInputElement>("#stream_message_recipient_topic")!
                .value,
            field_height: field.height,
            overflowing: [...document.querySelectorAll("#compose .compose_table *")].filter(
                (element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.right > field.right + 0.5;
                },
            ).length,
        };
    });
}

async function wait_for_compose_closed(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !document.querySelector("#compose")!.classList.contains("compose-box-open"),
    );
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function reply_in_conversations_test(page: Page): Promise<void> {
    const output = execSync("./manage.py shell", {encoding: "utf8", input: seed_script});
    const {stream_id} = JSON.parse(output.split("SEEDED ")[1]!) as {stream_id: number};
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await set_setting(
        page,
        "web_channel_default_view=5&color_scheme=3&web_font_size_px=15&web_line_height_percent=140",
    );
    await page.reload();
    await open_conversations(page, stream_id);

    // Reply in topic opens the row for that topic.
    await click_reply_in_topic(page, "coffee");
    let facts = await reply_facts(page);
    check(
        "Reply in topic opens the row under a line naming the topic",
        facts.open &&
            facts.reply &&
            facts.row_layout &&
            facts.line === "Reply in “coffee”" &&
            facts.line_shown &&
            !facts.recipient_row_shown &&
            !facts.close_shown &&
            !facts.new_conversation_shown &&
            facts.focused &&
            facts.topic === "coffee",
        JSON.stringify(facts),
    );
    check(
        "an empty reply is a 44px row, like the compose box of a conversation",
        Math.abs(facts.field_height - 44) < 0.5,
        String(facts.field_height),
    );
    await shot(page, "light-coffee");

    // A reply to another card names that topic, and keeps the first draft.
    await page.keyboard.type("Fresh beans arrived.");
    await click_reply_in_topic(page, "fridge");
    facts = await reply_facts(page);
    check(
        "replying to another card names its topic",
        facts.line === "Reply in “fridge”" && facts.topic === "fridge",
        JSON.stringify(facts),
    );
    const saved = await page.evaluate(() =>
        Object.values(localStorage).some((value) => value.includes("Fresh beans arrived.")),
    );
    check("the previous reply is kept as a draft", saved);

    // × closes it, and keeps what was typed as a draft.
    await page.keyboard.type("The fridge is full.");
    await page.click(".compose-reply-line-close");
    await wait_for_compose_closed(page);
    facts = await reply_facts(page);
    const kept = await page.evaluate(() =>
        Object.values(localStorage).some((value) => value.includes("The fridge is full.")),
    );
    check(
        "× closes the reply, keeps the draft and shows New conversation again",
        !facts.reply && !facts.row_layout && facts.new_conversation_shown && kept,
        JSON.stringify(facts),
    );

    // r replies to the selected message; Esc closes.
    await page.click(".focused-message-list .message_row .message_content");
    await page.waitForSelector("#compose.compose-reply-in-conversations", {visible: true});
    await page.keyboard.press("Escape");
    await wait_for_compose_closed(page);
    facts = await reply_facts(page);
    check(
        "clicking a message replies to its topic, and Esc closes the reply",
        !facts.reply && facts.new_conversation_shown,
        JSON.stringify(facts),
    );
    const hash_after_escape = await page.evaluate(() => window.location.hash);
    check(
        "Esc stays in the conversations view",
        hash_after_escape.startsWith("#conversations/"),
        hash_after_escape,
    );

    // Sending closes the reply.
    await click_reply_in_topic(page, "coffee");
    await page.evaluate(() => {
        document.querySelector<HTMLTextAreaElement>("#compose-textarea")!.value = "";
    });
    await page.click("#compose-textarea");
    await page.keyboard.type("Sending a reply.");
    await page.keyboard.press("Enter");
    await wait_for_compose_closed(page);
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".focused-message-list .message_content")].some(
                (content) => content.textContent?.includes("Sending a reply."),
            ),
        {polling: 100},
    );
    // The Enter that sent the reply does not open another one.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    facts = await reply_facts(page);
    check(
        "sending closes the reply and shows New conversation again",
        !facts.reply && facts.new_conversation_shown,
        JSON.stringify(facts),
    );

    // A new conversation is the form, not a reply.
    await page.keyboard.press("KeyC");
    await page.waitForSelector("#compose.new-conversation-form", {visible: true});
    facts = await reply_facts(page);
    check("c opens the new conversation form, not a reply", !facts.reply, JSON.stringify(facts));
    await page.click("#new-conversation-cancel");
    await wait_for_compose_closed(page);

    // A long topic is cut off in the line.
    await click_reply_in_topic(page, "a really long topic that will not fit in the line above it");
    await page.setViewport({width: 480, height: 900});
    await new Promise((resolve) => setTimeout(resolve, 500));
    facts = await reply_facts(page);
    check(
        "at 480px the line with the longest topic fits, and nothing overflows",
        facts.line_shown && facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot(page, "light-narrow-long");
    await page.setViewport({width: 360, height: 800});
    await new Promise((resolve) => setTimeout(resolve, 500));
    facts = await reply_facts(page);
    check(
        "in a narrower window a long topic is cut off, and nothing overflows",
        facts.line_truncated && facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await page.setViewport({width: 1280, height: 1000});

    // Leaving the view with what was typed keeps the classic compose box.
    await page.keyboard.type("Still typing.");
    await page.evaluate(() => {
        window.location.hash = "#feed";
    });
    await page.waitForFunction(() => window.location.hash === "#feed");
    await new Promise((resolve) => setTimeout(resolve, 700));
    facts = await reply_facts(page);
    check(
        "leaving the view keeps what was typed, with the recipient row",
        facts.open && !facts.reply && !facts.row_layout && facts.recipient_row_shown,
        JSON.stringify(facts),
    );
    await page.click("#compose_close");
    await wait_for_compose_closed(page);

    await set_setting(page, "color_scheme=2");
    await page.reload();
    await open_conversations(page, stream_id);
    await click_reply_in_topic(page, "fridge");
    await shot(page, "dark-fridge");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(reply_in_conversations_test);
