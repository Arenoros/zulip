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

type FormLayout = {
    card: {
        left: number;
        right: number;
        radius: string;
        shadow: string;
        background: string;
        border: string;
    };
    header: {
        author: string;
        avatar: number;
        author_size: number;
        channel_size: number;
        close_label: string;
        close_right: number;
    };
    cancel_shown: boolean;
    labels_shown: number;
    formatting_button_shown: boolean;
    topic: {
        height: number;
        font_size: number;
        font_weight: string;
        border_bottom: string;
        required: string | null;
    };
    toolbar: {
        shown: boolean;
        above_message: boolean;
        bold_shown: boolean;
        maximize_shown: boolean;
        delete_draft_shown: boolean;
    };
    message_height: number;
    bottom: {left: string[]; left_x: number; below_message: boolean};
    publish: {
        height: number;
        width: number;
        text: string;
        label: string | null;
        font: string;
        same_font_family: boolean;
        background: string;
        color: string;
        options_icon: string;
        options_after: boolean;
        options_right: number;
    };
    overflowing: number;
};

async function form_layout(page: Page): Promise<FormLayout> {
    return await page.evaluate(() => {
        const element = (selector: string): HTMLElement =>
            document.querySelector<HTMLElement>(`#compose ${selector}`)!;
        const shown = (selector: string): boolean => {
            const found = document.querySelector<HTMLElement>(`#compose ${selector}`);
            return found !== null && found.getClientRects().length > 0;
        };
        const rect = (selector: string): DOMRect => element(selector).getBoundingClientRect();
        const style = (selector: string): CSSStyleDeclaration =>
            getComputedStyle(element(selector));
        const font_size = (selector: string): number =>
            Math.round(Number.parseFloat(style(selector).fontSize));
        const card = rect(".compose_table");
        const message = rect("#compose-textarea");
        const toolbar = rect("#message-formatting-controls-container");
        const publish = rect("#compose-send-button");
        const options = rect("#send_later");
        const left_buttons = [
            ...document.querySelectorAll<HTMLElement>("#compose-row-buttons .compose-row-button"),
        ].filter((button) => button.getClientRects().length > 0);
        const button_names = ["emoji_map", "compose_upload_file", "compose-plus-menu-button"];
        return {
            card: {
                left: Math.round(card.left),
                right: Math.round(card.right),
                radius: style(".compose_table").borderRadius,
                shadow: style(".compose_table").boxShadow,
                background: style(".compose_table").backgroundColor,
                border: style(".compose_table").borderTopColor,
            },
            header: {
                author: element(".new-conversation-form-author").textContent.trim(),
                avatar: Math.round(rect(".new-conversation-form-avatar").width),
                author_size: font_size(".new-conversation-form-author"),
                channel_size: font_size(".new-conversation-form-channel"),
                close_label: element(".new-conversation-form-close").getAttribute("aria-label")!,
                close_right: Math.round(card.right - rect(".new-conversation-form-close").right),
            },
            cancel_shown: [...document.querySelectorAll<HTMLElement>("#compose button")].some(
                (button) =>
                    button.getClientRects().length > 0 && button.textContent.trim() === "Cancel",
            ),
            labels_shown: [...document.querySelectorAll<HTMLElement>("#compose label")].filter(
                (label) => label.getClientRects().length > 0,
            ).length,
            formatting_button_shown: shown(".compose-formatting-mode-button"),
            topic: {
                height: Math.round(rect("#compose-channel-recipient").height),
                font_size: font_size("#stream_message_recipient_topic"),
                font_weight: style("#stream_message_recipient_topic").fontWeight,
                border_bottom: [
                    style("#compose-channel-recipient").borderBottomWidth,
                    style("#compose-channel-recipient").borderBottomStyle,
                    style("#compose-channel-recipient").borderBottomColor,
                ].join(" "),
                required: element("#stream_message_recipient_topic").getAttribute(
                    "aria-required",
                ),
            },
            toolbar: {
                shown: shown("#message-formatting-controls-container"),
                above_message: toolbar.bottom <= message.top + 0.5,
                bold_shown: shown(".compose_control_button.zulip-icon-bold"),
                maximize_shown: shown(".maximize-composebox-button"),
                delete_draft_shown: shown(".compose-delete-draft-button"),
            },
            message_height: Math.round(message.height),
            bottom: {
                left: left_buttons.map(
                    (button) => button_names.find((name) => button.classList.contains(name)) ?? "",
                ),
                left_x: Math.round(left_buttons[0]!.getBoundingClientRect().left),
                below_message: left_buttons.every(
                    (button) => button.getBoundingClientRect().top >= message.bottom - 0.5,
                ),
            },
            publish: {
                height: Math.round(publish.height),
                width: Math.round(publish.width),
                text: element("#compose-send-button").textContent.trim(),
                label: element("#compose-send-button").getAttribute("aria-label"),
                font: `${style("#compose-send-button").fontSize} ${style("#compose-send-button").fontWeight}`,
                same_font_family:
                    style("#compose-send-button").fontFamily ===
                    style(".new-conversation-form-author").fontFamily,
                background: style("#compose-send-button").backgroundColor,
                color: style("#compose-send-button").color,
                options_icon: [...element("#send_later i").classList].find((name) =>
                    name.startsWith("zulip-icon-"),
                )!,
                options_after: options.left >= publish.right,
                options_right: Math.round(options.right),
            },
            overflowing: [...document.querySelectorAll("#compose .compose_table *")].filter(
                (child) => {
                    const child_rect = child.getBoundingClientRect();
                    return child_rect.width > 0 && child_rect.right > card.right + 0.5;
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
            form.title === "new conversation in #kitchen" &&
            !form.picker_shown &&
            placeholders.topic === "Conversation topic (required)" &&
            placeholders.message === "Message" &&
            placeholders.focused === "stream_message_recipient_topic",
        JSON.stringify({form, placeholders}),
    );
    let layout = await form_layout(page);
    check(
        "the form is a card with a shadow, under a header with the author and ×",
        layout.card.radius === "8px" &&
            layout.card.shadow.includes("0px 8px 24px") &&
            layout.card.background === "rgb(255, 255, 255)" &&
            layout.card.border === "rgb(224, 224, 224)" &&
            layout.header.author === "Desdemona" &&
            layout.header.avatar === 32 &&
            layout.header.author_size === 15 &&
            layout.header.channel_size === 13 &&
            layout.header.close_label === "Close without publishing" &&
            layout.header.close_right === 13 &&
            !layout.cancel_shown &&
            layout.labels_shown === 0,
        JSON.stringify(layout),
    );
    check(
        "the topic is 52px, in a 20px semibold font, over a 2px accent line",
        layout.topic.height === 52 &&
            layout.topic.font_size === 20 &&
            layout.topic.font_weight === "600" &&
            layout.topic.border_bottom === "2px solid rgb(91, 95, 199)" &&
            layout.topic.required === "true",
        JSON.stringify(layout.topic),
    );
    check(
        "the formatting toolbar shows, without Maximize or Delete draft",
        layout.toolbar.shown &&
            layout.toolbar.above_message &&
            layout.toolbar.bold_shown &&
            !layout.toolbar.maximize_shown &&
            !layout.toolbar.delete_draft_shown &&
            !layout.formatting_button_shown,
        JSON.stringify(layout.toolbar),
    );
    check(
        "the message is at least 130px, with Emoji, Attach and + below it on the left",
        layout.message_height >= 130 &&
            JSON.stringify(layout.bottom.left) ===
                JSON.stringify(["emoji_map", "compose_upload_file", "compose-plus-menu-button"]) &&
            layout.bottom.left_x - layout.card.left === 11 &&
            layout.bottom.below_message,
        JSON.stringify({message_height: layout.message_height, bottom: layout.bottom}),
    );
    check(
        "Publish is 36px high, at least 120px wide, next to ⋮, and inactive without a topic",
        layout.publish.height === 36 &&
            layout.publish.width >= 120 &&
            layout.publish.text === "Publish" &&
            layout.publish.label === "Publish" &&
            layout.publish.font === "15px 600" &&
            layout.publish.same_font_family &&
            layout.publish.background === "rgb(220, 220, 236)" &&
            layout.publish.color === "rgb(85, 87, 122)" &&
            layout.publish.options_icon === "zulip-icon-more-vertical" &&
            layout.publish.options_after &&
            layout.card.right - layout.publish.options_right === 17,
        JSON.stringify(layout.publish),
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
    layout = await form_layout(page);
    check(
        "with a topic and a message, Publish is enabled, in the accent color",
        !form.publish_disabled &&
            layout.publish.background === "rgb(91, 95, 199)" &&
            layout.publish.color === "rgb(255, 255, 255)",
        JSON.stringify({form, publish: layout.publish}),
    );
    await shot_compose(page, "light-form-filled");
    await page.click("#send_later i");
    await page.waitForSelector("#send_later_popover", {visible: true});
    const send_menu = await page.$eval("#send_later_popover", (popover) =>
        [...popover.querySelectorAll(".popover-menu-label")].map((label) =>
            label.textContent.trim(),
        ),
    );
    check(
        "⋮ opens the send options",
        send_menu.includes("Schedule message"),
        JSON.stringify(send_menu),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector("#send_later_popover", {hidden: true});
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

    // The c key, and × keeping a draft.
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
    await page.click(".new-conversation-form-close");
    await wait_for_compose_closed(page);
    // Drafts are kept in local storage under a versioned key.
    const drafts = await page.evaluate(() =>
        Object.keys(localStorage)
            .filter((key) => key.endsWith("__drafts"))
            .map((key) => localStorage.getItem(key))
            .join(""),
    );
    check(
        "× closes the form and keeps a draft",
        drafts.includes("The oven is broken.") && drafts.includes("oven"),
        drafts.slice(0, 200),
    );

    // Esc closes it too, staying in the view.
    await page.keyboard.press("KeyC");
    await page.waitForSelector("#compose.new-conversation-form #compose-textarea", {visible: true});
    await page.type("#stream_message_recipient_topic", "dishes");
    await page.keyboard.press("Escape");
    await wait_for_compose_closed(page);
    const after_escape = await page.evaluate(() => ({
        hash: window.location.hash,
        form: document.querySelector("#compose")!.classList.contains("new-conversation-form"),
    }));
    check(
        "Esc closes the form and stays in the view",
        after_escape.hash.startsWith("#conversations/") && !after_escape.form,
        JSON.stringify(after_escape),
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
    const reply_row = await page.$eval("#compose", (compose) =>
        compose.classList.contains("compose-reply-in-conversations"),
    );
    check(
        "Reply in topic opens the reply to that topic from the form",
        form.open && !form.form && reply_row && form.topic === "coffee",
        JSON.stringify({...form, reply_row}),
    );
    await page.click(".compose-reply-line-close");
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
    await page.waitForSelector("#compose.compose-for-view");
    form = await form_state(page);
    const saved_as_draft = await page.evaluate(() =>
        Object.values(localStorage).some((value) => value.includes("Lunch menu ideas.")),
    );
    check(
        "leaving the view saves what was typed as a draft, and the topic gets its own compose box",
        form.open && !form.form && form.topic === "fridge" && saved_as_draft,
        JSON.stringify({...form, saved_as_draft}),
    );

    // Dark theme, and a narrow window.
    await set_setting(page, "color_scheme=2");
    await page.reload();
    await open_conversations(page, stream_id);
    await page.click("#legacy-closed-compose-box .topic-cards-new-conversation-button");
    await page.waitForSelector("#compose.new-conversation-form", {visible: true});
    layout = await form_layout(page);
    check(
        "in the dark theme, the card and the inactive Publish have the colors of the design",
        layout.card.background === "rgb(41, 41, 41)" &&
            layout.card.border === "rgb(58, 58, 58)" &&
            layout.topic.border_bottom === "2px solid rgb(127, 133, 245)" &&
            layout.publish.background === "rgb(58, 59, 85)" &&
            layout.publish.color === "rgb(169, 171, 201)",
        JSON.stringify({card: layout.card, topic: layout.topic, publish: layout.publish}),
    );
    await shot_compose(page, "dark-form");
    await page.click(".new-conversation-form-close");
    await wait_for_compose_closed(page);

    await page.setViewport({width: 480, height: 900});
    await page.reload();
    await open_conversations(page, stream_id);
    const narrow_button = await page.$eval(
        "#legacy-closed-compose-box .topic-cards-new-conversation-button",
        (button) => {
            const rect = button.getBoundingClientRect();
            const box = document
                .querySelector("#legacy-closed-compose-box")!
                .getBoundingClientRect();
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
    layout = await form_layout(page);
    check(
        "in a 480px window, the form fits",
        !narrow_form.overflowing && layout.overflowing === 0,
        JSON.stringify({narrow_form, overflowing: layout.overflowing}),
    );
    await shot_compose(page, "dark-480-form");
    await page.click(".new-conversation-form-close");
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
