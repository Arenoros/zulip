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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "topic-card-actions";

const seed_script = String.raw`import json

from zerver.actions.message_send import internal_send_stream_message
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
stream, _ = create_stream_if_needed(realm, "launch", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, hamlet], acting_user=None)
ids = {}
for topic in ["checklist", "venue", "press"]:
    ids[topic] = internal_send_stream_message(hamlet, stream, topic, f"About the {topic}.")
    internal_send_stream_message(desdemona, stream, topic, "Noted.")
print("SEEDED " + json.dumps({"ids": ids, "stream_id": stream.id}))
`;

type Seeded = {ids: Record<string, number>; stream_id: number};

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

function card(title: string): string {
    return `.focused-message-list .recipient_row:has(.topic-card-title-text[data-test-title="${title}"])`;
}

// Marks each card with its title, so that a card can be selected by it.
async function label_cards(page: Page): Promise<void> {
    await page.evaluate(() => {
        for (const title of document.querySelectorAll<HTMLElement>(
            ".focused-message-list .topic-card-title-text",
        )) {
            title.dataset["testTitle"] = title.textContent.trim();
        }
    });
}

async function panel_state(page: Page, title: string): Promise<{
    visible: boolean;
    buttons: string[];
    hidden_parts_shown: number;
}> {
    return await page.$eval(card(title), (card) => {
        const panel = card.querySelector(".message_header")!;
        const shown = (element: Element): boolean =>
            getComputedStyle(element).display !== "none" &&
            element.getBoundingClientRect().width > 0;
        return {
            visible:
                getComputedStyle(panel).opacity === "1" &&
                getComputedStyle(panel.querySelector(".recipient_bar_controls")!).opacity === "1",
            buttons: [...panel.querySelectorAll(".recipient-bar-control")]
                .filter((button) => shown(button))
                .map((button) =>
                    [...button.classList].find((name) =>
                        [
                            "topic-card-react",
                            "on_hover_topic_resolve",
                            "recipient-bar-copy-link-to-topic",
                            "change_visibility_policy",
                            "recipient-row-topic-menu",
                        ].includes(name),
                    ) ?? button.className,
                ),
            hidden_parts_shown: [
                ...panel.querySelectorAll(
                    ".stream_label, .stream_topic, .recipient_row_date, .on_hover_topic_edit",
                ),
            ].filter((element) => shown(element)).length,
        };
    });
}

async function hover_card(page: Page, title: string): Promise<void> {
    await page.hover(`${card(title)} .topic-card-title-text`);
    await page.waitForFunction(
        (selector: string) =>
            getComputedStyle(document.querySelector(`${selector} .message_header`)!).opacity ===
            "1",
        {},
        card(title),
    );
    // Besides the hovered card, only the card holding the selected
    // message may show its panel, on screens without hover, which
    // include headless Chrome.
    const others_shown = await page.$$eval(
        ".focused-message-list .recipient_row",
        (cards, hovered) =>
            cards.filter(
                (card) =>
                    !card.matches(hovered) &&
                    !(
                        matchMedia("(hover: none)").matches &&
                        card.querySelector(".selected_message") !== null
                    ) &&
                    getComputedStyle(card.querySelector(".message_header")!).opacity === "1",
            ).length,
        card(title),
    );
    check(`hovering "${title}" shows no other card's panel`, others_shown === 0, String(others_shown));
}

// Counts the buttons of a card's panel that something else covers.
async function covered_buttons(page: Page, title: string): Promise<number> {
    return await page.$eval(card(title), (card) => {
        const panel = card.querySelector(".message_header")!;
        return [...panel.querySelectorAll(".recipient-bar-control-icon")]
            .map((button) => button.getBoundingClientRect())
            .filter((rect) => rect.width > 0)
            .filter((rect) => {
                const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + 2);
                return hit === null || !panel.contains(hit);
            }).length;
    });
}

async function topic_card_actions_test(page: Page): Promise<void> {
    const output = execSync("./manage.py shell", {encoding: "utf8", input: seed_script});
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await set_setting(
        page,
        "web_channel_default_view=5&color_scheme=3&web_font_size_px=15&timezone=UTC",
    );
    await page.goto(`${base_url}#conversations/channel/${seeded.stream_id}`);
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await label_cards(page);
    await page.mouse.move(1, 1);

    const hidden = await panel_state(page, "venue");
    check("the panel is hidden until the card is hovered", !hidden.visible, JSON.stringify(hidden));
    const selected_card = await page.evaluate(() => ({
        no_hover: matchMedia("(hover: none)").matches,
        shown:
            getComputedStyle(
                document.querySelector(
                    ".focused-message-list .recipient_row:has(.selected_message) .message_header",
                )!,
            ).opacity === "1",
    }));
    check(
        "on screens without hover, the card holding the selected message shows its panel",
        selected_card.shown === selected_card.no_hover,
        JSON.stringify(selected_card),
    );

    // The panel's buttons stay in the tab order.
    await page.focus(`${card("venue")} .topic-card-react .recipient-bar-control-icon`);
    const focused = await panel_state(page, "venue");
    check("focusing a panel button shows the panel", focused.visible, JSON.stringify(focused));
    await page.evaluate(() => {
        (document.activeElement as HTMLElement).blur();
    });

    await hover_card(page, "venue");
    const shown = await panel_state(page, "venue");
    check(
        "hovering a card shows its topic actions, without the bar's names and date",
        shown.visible &&
            JSON.stringify(shown.buttons) ===
                JSON.stringify([
                    "topic-card-react",
                    "on_hover_topic_resolve",
                    "change_visibility_policy",
                    "recipient-bar-copy-link-to-topic",
                    "recipient-row-topic-menu",
                ]) &&
            shown.hidden_parts_shown === 0,
        JSON.stringify(shown),
    );
    const geometry = await page.$eval(card("venue"), (card) => {
        const panel = card
            .querySelector(".message_header .recipient_bar_controls")!
            .getBoundingClientRect();
        const box = card.getBoundingClientRect();
        const time = document.createRange();
        time.selectNodeContents(card.querySelector(".message-time")!);
        const card_above = card.previousElementSibling!;
        return {
            panel_top: panel.top,
            panel_bottom: panel.bottom,
            card_top: box.top,
            time_text_top: time.getBoundingClientRect().top,
            reply_button_above_bottom: card_above
                .querySelector(".topic-card-reply-button")!
                .getBoundingClientRect().bottom,
            panel_right: panel.right,
            card_right: box.right,
        };
    });
    check(
        "the panel sits over the card's top edge, on the right, clear of the message's time and the card above",
        geometry.panel_top < geometry.card_top &&
            geometry.panel_bottom <= geometry.time_text_top &&
            geometry.panel_top > geometry.reply_button_above_bottom &&
            geometry.panel_right < geometry.card_right &&
            geometry.card_right - geometry.panel_right < 30,
        JSON.stringify(geometry),
    );
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-light-hover.png`,
        clip: await page.$eval(card("venue"), (card) => {
            const rect = card.getBoundingClientRect();
            return {
                x: rect.left - 8,
                y: rect.top + window.scrollY - 30,
                width: rect.width + 16,
                height: rect.height + 40,
            };
        }),
    });

    // A reaction on the topic's first message.
    await page.click(`${card("venue")} .topic-card-react`);
    await page.waitForSelector(".emoji-picker-popover", {visible: true});
    await page.type("#emoji-popover-filter", "thumbs");
    await page.keyboard.press("Enter");
    await page.waitForSelector(
        `.focused-message-list .message_row[data-message-id="${seeded.ids["venue"]}"] .message_reaction`,
        {visible: true},
    );
    check("the reaction button reacts to the topic's first message", true);

    // Copying the link to the topic.
    await hover_card(page, "venue");
    await page.click(`${card("venue")} .recipient-bar-copy-link-to-topic`);
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".tippy-content")].some(
            (tooltip) => tooltip.textContent.trim() === "Copied!",
        ),
    );
    check("the link button copies the link to the topic", true);

    // The topic menu.
    await hover_card(page, "press");
    await page.click(`${card("press")} .recipient-row-topic-menu`);
    await page.waitForSelector("#topic-actions-menu-popover", {visible: true});
    const menu_topic = await page.$eval("#topic-actions-menu-popover", (menu) =>
        menu.textContent.includes("press"),
    );
    check("the menu button opens the topic's menu", menu_topic);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#topic-actions-menu-popover", {hidden: true});

    // Resolving the topic.
    await hover_card(page, "checklist");
    const first_card_covered = await covered_buttons(page, "checklist");
    check(
        "at the top of the view, the first card's panel is clear of the navbar",
        first_card_covered === 0,
        String(first_card_covered),
    );
    await page.click(`${card("checklist")} .on_hover_topic_resolve`);
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".focused-message-list .recipient_row")].some(
            (card) =>
                card.querySelector(".topic-card-title-text")?.textContent.trim() === "checklist" &&
                card.querySelector(".topic-card-resolved-label") !== null,
        ),
    );
    check("the resolve button resolves the topic, which gets the label", true);

    // A card scrolled up under the navbar keeps its panel in view.
    await label_cards(page);
    const card_top_under_navbar = await page.evaluate((selector: string) => {
        const navbar_bottom = document
            .querySelector("#navbar-fixed-container")!
            .getBoundingClientRect().bottom;
        const card = document.querySelector(selector)!;
        window.scrollBy(0, card.getBoundingClientRect().top - navbar_bottom + 40);
        return navbar_bottom - card.getBoundingClientRect().top;
    }, card("press"));
    await hover_card(page, "press");
    const scrolled_card_covered = await covered_buttons(page, "press");
    check(
        "a card scrolled up under the navbar keeps its panel clear of the navbar",
        card_top_under_navbar > 30 && scrolled_card_covered === 0,
        JSON.stringify({card_top_under_navbar, scrolled_card_covered}),
    );
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-light-scrolled.png`,
        clip: await page.$eval(card("press"), (card) => {
            const rect = card.getBoundingClientRect();
            return {x: rect.left - 8, y: window.scrollY, width: rect.width + 16, height: 220};
        }),
    });

    // Muting the topic from the bell.
    await page.click(`${card("press")} .change_visibility_policy`);
    await page.waitForSelector(".visibility-policy-popover", {visible: true});
    await page.click('.visibility-policy-popover label[for="select-muted-policy"]');
    await page.waitForFunction(
        () =>
            ![...document.querySelectorAll(".focused-message-list .topic-card-title-text")].some(
                (title) => title.textContent.trim() === "press",
            ),
    );
    check("muting the topic from the bell removes its card", true);

    // Unresolving the topic from its menu, as in the recipient bar.
    await label_cards(page);
    await hover_card(page, "checklist");
    await page.click(`${card("checklist")} .recipient-row-topic-menu`);
    await page.waitForSelector("#topic-actions-menu-popover .sidebar-popover-toggle-resolved", {
        visible: true,
    });
    await page.click("#topic-actions-menu-popover .sidebar-popover-toggle-resolved");
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".focused-message-list .recipient_row")].some(
            (card) =>
                card.querySelector(".topic-card-title-text")?.textContent.trim() === "checklist" &&
                card.querySelector(".topic-card-resolved-label") === null,
        ),
    );
    check("the topic menu unresolves the topic, which loses the label", true);

    // The dark theme.
    await set_setting(page, "color_scheme=2");
    await page.reload();
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await label_cards(page);
    await hover_card(page, "venue");
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-dark-hover.png`,
        clip: await page.$eval(card("venue"), (card) => {
            const rect = card.getBoundingClientRect();
            return {
                x: rect.left - 8,
                y: rect.top + window.scrollY - 30,
                width: rect.width + 16,
                height: rect.height + 40,
            };
        }),
    });

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(topic_card_actions_test);
