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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "new-conversation";

const seed_script = String.raw`import json

from zerver.actions.message_send import internal_send_stream_message
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
stream, _ = create_stream_if_needed(realm, "kitchen", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, hamlet], acting_user=None)
for topic in ["coffee", "fridge"]:
    internal_send_stream_message(hamlet, stream, topic, f"About the {topic}.")
print("SEEDED " + json.dumps({"stream_id": stream.id}))
`;

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

async function open_conversations(page: Page, stream_id: number): Promise<void> {
    await page.goto(`${base_url}#conversations/channel/${stream_id}-kitchen`);
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await page.mouse.move(1, 1);
}

async function card_titles(page: Page): Promise<string[]> {
    return await page.$$eval(".focused-message-list .topic-card-title-text", (titles) =>
        titles.map((title) => title.textContent.trim()),
    );
}

async function form_state(page: Page): Promise<{
    open: boolean;
    form: boolean;
    title: string;
    picker_shown: boolean;
    publish_disabled: boolean;
    topic: string;
}> {
    return await page.evaluate(() => {
        const compose = document.querySelector("#compose")!;
        const picker = document.querySelector("#compose_select_recipient_widget_wrapper");
        return {
            open: compose.classList.contains("compose-box-open"),
            form: compose.classList.contains("new-conversation-form"),
            title: document.querySelector("#new-conversation-form-title")!.textContent.trim(),
            picker_shown: picker !== null && getComputedStyle(picker).display !== "none",
            publish_disabled: document
                .querySelector("#compose-send-button")!
                .classList.contains("disabled-message-send-controls"),
            topic: document.querySelector<HTMLInputElement>("#stream_message_recipient_topic")!
                .value,
        };
    });
}

async function wait_for_compose_closed(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !document.querySelector("#compose")!.classList.contains("compose-box-open"),
    );
}

async function shot_compose(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function new_conversation_test(page: Page): Promise<void> {
    const output = execSync("./manage.py shell", {encoding: "utf8", input: seed_script});
    const {stream_id} = JSON.parse(output.split("SEEDED ")[1]!) as {stream_id: number};
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await set_setting(
        page,
        "web_channel_default_view=5&color_scheme=3&web_font_size_px=15&timezone=UTC",
    );
    await page.reload();
    await open_conversations(page, stream_id);

    // The bottom of the view.
    const bar = await page.evaluate(() => {
        const shown = (selector: string): boolean => {
            const element = document.querySelector(`#legacy-closed-compose-box ${selector}`);
            return element !== null && element.getBoundingClientRect().width > 0;
        };
        const button = document
            .querySelector("#legacy-closed-compose-box .topic-cards-new-conversation-button")!
            .getBoundingClientRect();
        return {
            reply: shown(".reply_button_container"),
            direct: shown(".new_direct_message_button_container"),
            new_conversation: shown(".topic-cards-new-conversation-button"),
            height: Math.round(button.height),
        };
    });
    check(
        "the conversations view offers only a 44px New conversation button",
        !bar.reply && !bar.direct && bar.new_conversation && bar.height === 44,
        JSON.stringify(bar),
    );

    // The form.
    await page.click("#legacy-closed-compose-box .topic-cards-new-conversation-button");
    await page.waitForSelector("#compose.new-conversation-form #compose-textarea", {visible: true});
    let form = await form_state(page);
    const placeholders = await page.evaluate(() => ({
        topic: document.querySelector<HTMLInputElement>("#stream_message_recipient_topic")!
            .placeholder,
        message: document.querySelector<HTMLTextAreaElement>("#compose-textarea")!.placeholder,
        focused: document.activeElement?.id,
    }));
    check(
        "the button opens the form for the channel, with the topic first",
        form.open &&
            form.form &&
            form.title === "New conversation in #kitchen" &&
            !form.picker_shown &&
            placeholders.topic === "What is the conversation about" &&
            placeholders.message === "First message of the conversation" &&
            placeholders.focused === "stream_message_recipient_topic",
        JSON.stringify({form, placeholders}),
    );
    const cards_before = await card_titles(page);
    const faded = await page.$$eval(
        ".focused-message-list .recipient_row.message-fade",
        (cards) => cards.length,
    );
    check("the form does not fade the cards", faded === 0, String(faded));
    await shot_compose(page, "light-form");

    // A topic is required, though the organization allows messages
    // without one.
    await page.click("#compose-textarea");
    await page.type("#compose-textarea", "Who wants to go on Saturday?");
    form = await form_state(page);
    await page.keyboard.press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    check(
        "without a topic, Publish is disabled and Enter sends nothing",
        form.publish_disabled &&
            JSON.stringify(await card_titles(page)) === JSON.stringify(cards_before),
        JSON.stringify(form),
    );

    await page.type("#stream_message_recipient_topic", "picnic");
    form = await form_state(page);
    check("with a topic, Publish is enabled", !form.publish_disabled, JSON.stringify(form));
    await page.click("#compose-send-button");
    await wait_for_compose_closed(page);
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".focused-message-list .topic-card-title-text")].some(
            (title) => title.textContent.trim() === "picnic",
        ),
    );
    const published = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".focused-message-list .recipient_row")];
        const last = cards.at(-1)!;
        return {
            last_title: last.querySelector(".topic-card-title-text")?.textContent.trim(),
            highlighted: last.classList.contains("topic-card-new"),
            hash: window.location.hash,
            form: document.querySelector("#compose")!.classList.contains("new-conversation-form"),
        };
    });
    check(
        "publishing closes the form and highlights the new card at the bottom of the view",
        published.last_title === "picnic" &&
            published.highlighted &&
            published.hash.startsWith("#conversations/channel/") &&
            !published.form,
        JSON.stringify(published),
    );
    await shot_compose(page, "light-published");

    // The c key, and Cancel keeping a draft.
    await page.keyboard.press("KeyC");
    await page.waitForSelector("#compose.new-conversation-form #compose-textarea", {visible: true});
    form = await form_state(page);
    check(
        "c opens the form with an empty topic",
        form.form && form.topic === "",
        JSON.stringify(form),
    );
    await page.type("#stream_message_recipient_topic", "oven");
    await page.click("#compose-textarea");
    await page.type("#compose-textarea", "The oven is broken.");
    await page.click("#new-conversation-cancel");
    await wait_for_compose_closed(page);
    // Drafts are kept in local storage under a versioned key.
    const drafts = await page.evaluate(() =>
        Object.keys(localStorage)
            .filter((key) => key.endsWith("__drafts"))
            .map((key) => localStorage.getItem(key))
            .join(""),
    );
    check(
        "Cancel closes the form and keeps a draft",
        drafts.includes("The oven is broken.") && drafts.includes("oven"),
        drafts.slice(0, 200),
    );

    // The form does not leak into replies.
    await page.click("#legacy-closed-compose-box .topic-cards-new-conversation-button");
    await page.waitForSelector("#compose.new-conversation-form", {visible: true});
    await page.evaluate(() => {
        const card = [...document.querySelectorAll(".focused-message-list .recipient_row")].find(
            (card) => card.querySelector(".topic-card-title-text")?.textContent.trim() === "coffee",
        )!;
        card.querySelector<HTMLElement>(".topic-card-reply-button")!.click();
    });
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLInputElement>("#stream_message_recipient_topic")!.value ===
            "coffee",
    );
    form = await form_state(page);
    check(
        "Reply in topic opens the regular compose box from the form",
        form.open && !form.form && form.picker_shown,
        JSON.stringify(form),
    );
    await page.click("#compose_close");
    await wait_for_compose_closed(page);

    await page.click("#legacy-closed-compose-box .topic-cards-new-conversation-button");
    await page.waitForSelector("#compose.new-conversation-form", {visible: true});
    await page.type("#stream_message_recipient_topic", "menu");
    await page.click("#compose-textarea");
    await page.type("#compose-textarea", "Lunch menu ideas.");
    await page.goto(`${base_url}#narrow/channel/${stream_id}-kitchen/topic/fridge`);
    await page.waitForSelector(".focused-message-list.open-conversation .message_row", {
        visible: true,
    });
    form = await form_state(page);
    check(
        "leaving the view keeps what was typed in the regular compose box",
        form.open && !form.form && form.picker_shown && form.topic === "menu",
        JSON.stringify(form),
    );
    await page.click("#compose_close");
    await wait_for_compose_closed(page);

    // Dark theme, and a narrow window.
    await set_setting(page, "color_scheme=2");
    await page.reload();
    await open_conversations(page, stream_id);
    await page.click("#legacy-closed-compose-box .topic-cards-new-conversation-button");
    await page.waitForSelector("#compose.new-conversation-form", {visible: true});
    await shot_compose(page, "dark-form");
    await page.click("#new-conversation-cancel");
    await wait_for_compose_closed(page);

    await page.setViewport({width: 480, height: 900});
    await page.reload();
    await open_conversations(page, stream_id);
    const narrow_button = await page.$eval(
        "#legacy-closed-compose-box .topic-cards-new-conversation-button",
        (button) => {
            const rect = button.getBoundingClientRect();
            const box = document.querySelector("#legacy-closed-compose-box")!.getBoundingClientRect();
            return {
                height: Math.round(rect.height),
                full_width: Math.abs(rect.width - box.width) < 2,
            };
        },
    );
    check(
        "in a 480px window, the button is 44px high across the whole width",
        narrow_button.height === 44 && narrow_button.full_width,
        JSON.stringify(narrow_button),
    );
    await shot_compose(page, "dark-480");
    await page.click("#legacy-closed-compose-box .topic-cards-new-conversation-button");
    await page.waitForSelector("#compose.new-conversation-form", {visible: true});
    const narrow_form = await page.evaluate(() => {
        const compose = document.querySelector("#compose-content")!;
        return {overflowing: compose.scrollWidth > compose.clientWidth};
    });
    check(
        "in a 480px window, the form fits",
        !narrow_form.overflowing,
        JSON.stringify(narrow_form),
    );
    await shot_compose(page, "dark-480-form");
    await page.click("#new-conversation-cancel");
    await wait_for_compose_closed(page);
    await page.setViewport({width: 1280, height: 1000});

    // With another default view for channels, nothing changes.
    await set_setting(page, "web_channel_default_view=1&color_scheme=3");
    await page.goto(`${base_url}#narrow/channel/${stream_id}-kitchen`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    const classic = await page.evaluate(() => {
        const shown = (selector: string): boolean => {
            const element = document.querySelector(`#legacy-closed-compose-box ${selector}`);
            return element !== null && element.getBoundingClientRect().width > 0;
        };
        return {
            reply: shown(".reply_button_container"),
            direct: shown(".new_direct_message_button_container"),
            new_conversation: shown(".topic-cards-new-conversation-button"),
        };
    });
    await page.click("#new_conversation_button");
    await page.waitForSelector("#compose-textarea", {visible: true});
    form = await form_state(page);
    check(
        "in the channel feed, the compose box and its buttons are as before",
        classic.reply && classic.direct && !classic.new_conversation && !form.form,
        JSON.stringify({classic, form}),
    );

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(new_conversation_test);
