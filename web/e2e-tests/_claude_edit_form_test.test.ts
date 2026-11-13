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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "edit-form";

const seed_script = String.raw`import json

from zerver.actions.message_send import (
    internal_send_private_message,
    internal_send_stream_message,
)
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
stream, _ = create_stream_if_needed(realm, "workshop", acting_user=None)
bulk_add_subscriptions(realm, [stream], [desdemona, iago], acting_user=None)
from_iago = internal_send_private_message(iago, desdemona, "A message from Iago.")
bubble = internal_send_private_message(desdemona, iago, "Edit me in a bubble.")
card = internal_send_stream_message(desdemona, stream, "plans", "Edit me in a card.")
print(
    "SEEDED "
    + json.dumps(
        {
            "desdemona": desdemona.id,
            "iago": iago.id,
            "stream_id": stream.id,
            "from_iago": from_iago,
            "bubble": bubble,
            "card": card,
        }
    )
)
`;

type Seeded = {desdemona: number; iago: number; stream_id: number; from_iago: number; bubble: number; card: number};

async function api(page: Page, method: string, url: string, body: string): Promise<void> {
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
        throw new Error(`${method} ${url} ${body}: ${status}`);
    }
}

async function go_to(page: Page, hash: string, selector: string): Promise<void> {
    await page.evaluate((hash) => {
        window.location.hash = hash;
    }, hash);
    await page.waitForSelector(selector, {visible: true});
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.mouse.move(1, 1);
}

const row = (id: number): string => `.focused-message-list .message_row[data-message-id="${id}"]`;

async function open_edit(page: Page, id: number): Promise<void> {
    // A message just saved is drawn again, without the hover controls
    // until the mouse moves over it anew.
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.hover(`${row(id)} .message_content`);
    await page.waitForSelector(`${row(id)} .message-actions-menu-button`, {visible: true});
    await page.click(`${row(id)} .message-actions-menu-button`);
    await page.waitForSelector(".popover_edit_message", {visible: true});
    await page.click(".popover_edit_message");
    await page.waitForSelector(`${row(id)} .message_edit_form`, {visible: true});
    await new Promise((resolve) => setTimeout(resolve, 300));
}

// Until the server confirms an edit, the row says SAVING; the
// confirmation draws the row again.
async function wait_for_saved(page: Page, id: number, text: string): Promise<void> {
    await page.waitForFunction(
        (selector, text) => {
            const message = document.querySelector(selector);
            return (
                message?.querySelector(".message_content")?.textContent.includes(text) === true &&
                message.querySelector(".message_edit_notice")?.textContent.trim() === "EDITED"
            );
        },
        {},
        row(id),
        text,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
}

async function wait_for_edit_closed(page: Page, id: number): Promise<void> {
    await page.waitForSelector(`${row(id)} .message_edit_form`, {hidden: true});
}

type EditFacts = {
    field: {width: number; height: number};
    row_buttons: string[];
    controls: string[];
    one_row: boolean;
    buttons_below_message: boolean;
    toolbar_shown: boolean;
    toolbar_above_message: boolean;
    formatting_pressed: string | null;
    message_height: number;
    timer: string;
    timer_above_buttons: boolean;
    overflowing: number;
    compose_formatting: boolean;
    compose_text: string;
};

async function edit_facts(page: Page, id: number): Promise<EditFacts> {
    return await page.$eval(row(id), (row) => {
        const shown = (element: Element | null): element is HTMLElement =>
            element !== null && element.getClientRects().length > 0;
        const field = row.querySelector(".message-edit-field")!.getBoundingClientRect();
        const textarea = row.querySelector(".message_edit_content")!.getBoundingClientRect();
        const toolbar = row.querySelector(".message-edit-feature-group");
        const names = [
            "compose-formatting-mode-button",
            "emoji_map",
            "compose_upload_file",
            "compose-plus-menu-button",
        ];
        const row_buttons = [
            ...row.querySelectorAll<HTMLElement>(".message-edit-row-buttons .compose-row-button"),
        ].filter((button) => shown(button));
        const controls = [
            ...row.querySelectorAll<HTMLElement>(".message-edit-buttons-and-timer button"),
        ].filter((button) => shown(button));
        const centers = [...row_buttons, ...controls].map((element) => {
            const rect = element.getBoundingClientRect();
            return (rect.top + rect.bottom) / 2;
        });
        const timer = row.querySelector(".message-edit-timer");
        const timer_rect = shown(timer) ? timer.getBoundingClientRect() : undefined;
        const control_top = Math.min(
            ...controls.map((button) => button.getBoundingClientRect().top),
        );
        return {
            field: {width: field.width, height: field.height},
            row_buttons: row_buttons.map(
                (button) => names.find((name) => button.classList.contains(name)) ?? "",
            ),
            controls: controls.map((button) => button.textContent.trim()),
            one_row:
                centers.every((center) => Math.abs(center - centers[0]!) < 1) &&
                centers.every((center) => center > textarea.top && center < textarea.bottom),
            buttons_below_message: row_buttons.every(
                (button) => button.getBoundingClientRect().top >= textarea.bottom - 0.5,
            ),
            toolbar_shown: shown(toolbar),
            toolbar_above_message:
                shown(toolbar) && toolbar.getBoundingClientRect().bottom <= textarea.top + 0.5,
            formatting_pressed:
                row.querySelector(".compose-formatting-mode-button")?.getAttribute(
                    "aria-pressed",
                ) ?? null,
            message_height: textarea.height,
            timer: shown(timer) ? timer.textContent.trim() : "",
            timer_above_buttons:
                timer_rect !== undefined && timer_rect.bottom <= control_top + 0.5,
            overflowing: [...row.querySelectorAll(".message-edit-field *")].filter((child) => {
                const rect = child.getBoundingClientRect();
                return rect.width > 0 && rect.right > field.right + 0.5;
            }).length,
            compose_formatting: document
                .querySelector("#compose")!
                .classList.contains("formatting-mode"),
            compose_text: document.querySelector<HTMLTextAreaElement>("#compose-textarea")!.value,
        };
    });
}

async function shot(page: Page, id: number, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.$eval(row(id), (row) => {
        row.scrollIntoView({block: "center"});
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.$eval(row(id), (row) => {
        const rect = row.getBoundingClientRect();
        const top = Math.min(Math.max(0, rect.top - 40), window.innerHeight - 1);
        const bottom = Math.min(Math.max(rect.bottom + 120, top + 1), window.innerHeight);
        // The clip is in page coordinates.
        return {x: 0, y: top + window.scrollY, width: window.innerWidth, height: bottom - top};
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function message_text(page: Page, id: number): Promise<string> {
    return await page.$eval(`${row(id)} .message_content`, (content) =>
        content.textContent.trim(),
    );
}

async function edit_form_test(page: Page): Promise<void> {
    const output = execSync("./manage.py shell", {encoding: "utf8", input: seed_script});
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await api(
        page,
        "PATCH",
        "/json/settings",
        "color_scheme=3&web_font_size_px=15&web_line_height_percent=140&enter_sends=true&web_channel_default_view=5",
    );
    await api(
        page,
        "POST",
        "/json/saved_snippets",
        "title=Greeting&content=" + encodeURIComponent("Hello from a snippet."),
    );
    await page.reload();
    const dm = `#narrow/dm/${seeded.iago}-Iago`;
    await go_to(page, dm, `${row(seeded.bubble)}`);

    // Whatever is typed in the compose box stays there.
    await page.click("#compose-textarea");
    await page.keyboard.type("Draft in the compose box.");

    // The edit form is the row of the compose box.
    await open_edit(page, seeded.bubble);
    let facts = await edit_facts(page, seeded.bubble);
    check(
        "the edit form is a row: the message, Formatting, Emoji, Attach, +, Cancel and Save",
        JSON.stringify(facts.row_buttons) ===
            JSON.stringify([
                "compose-formatting-mode-button",
                "emoji_map",
                "compose_upload_file",
                "compose-plus-menu-button",
            ]) &&
            JSON.stringify(facts.controls) === JSON.stringify(["Cancel", "Save"]) &&
            facts.one_row &&
            !facts.toolbar_shown &&
            Math.abs(facts.field.height - 44) < 0.5 &&
            facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot(page, seeded.bubble, "light-bubble");

    // Formatting mode, apart from the compose box.
    await page.click(`${row(seeded.bubble)} .compose-formatting-mode-button`);
    facts = await edit_facts(page, seeded.bubble);
    check(
        "Formatting shows the toolbar above a taller message, in the edit form only",
        facts.toolbar_shown &&
            facts.toolbar_above_message &&
            facts.message_height >= 139.5 &&
            facts.formatting_pressed === "true" &&
            facts.buttons_below_message &&
            !facts.compose_formatting &&
            facts.compose_text === "Draft in the compose box." &&
            facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot(page, seeded.bubble, "light-bubble-formatting");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A second line.");
    const still_open = await page.$eval(
        `${row(seeded.bubble)} .message_edit_content`,
        (textarea) => (textarea as HTMLTextAreaElement).value,
    );
    check(
        "in formatting mode, Enter starts a new line",
        still_open === "Edit me in a bubble.\nA second line.",
        JSON.stringify(still_open),
    );
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await wait_for_edit_closed(page, seeded.bubble);
    await wait_for_saved(page, seeded.bubble, "A second line.");
    check("Ctrl+Enter saves", true);

    // The + menu has just global times and saved snippets, for the
    // message being edited.
    await open_edit(page, seeded.bubble);
    facts = await edit_facts(page, seeded.bubble);
    check(
        "a new edit starts as a row",
        !facts.toolbar_shown && facts.formatting_pressed === "false",
        JSON.stringify(facts),
    );
    await page.click(`${row(seeded.bubble)} .compose-plus-menu-button`);
    await page.waitForSelector("#compose-plus-menu-popover", {visible: true});
    const menu = await page.$$eval("#compose-plus-menu-popover .popover-menu-label", (labels) =>
        labels.map((label) => label.textContent.trim()),
    );
    check(
        "the + menu of the edit form has Global time and Saved snippets",
        JSON.stringify(menu) === JSON.stringify(["Global time", "Saved snippets"]),
        JSON.stringify(menu),
    );
    await shot(page, seeded.bubble, "light-bubble-plus-menu");
    await page.click(".compose-plus-menu-global-time");
    await page.waitForSelector(".flatpickr-calendar.open", {visible: true});
    await page.click(".flatpickr-calendar.open .flatpickr-confirm");
    await page.waitForSelector(".flatpickr-calendar.open", {hidden: true});
    await page.click(`${row(seeded.bubble)} .compose-plus-menu-button`);
    await page.waitForSelector("#compose-plus-menu-popover", {visible: true});
    await page.click(".compose-plus-menu-saved-snippets");
    await page.waitForSelector(".dropdown-list-container", {visible: true});
    await page.evaluate(() => {
        const item = [...document.querySelectorAll<HTMLElement>(".dropdown-list-item-name")].find(
            (name) => name.textContent.trim() === "Greeting",
        )!;
        item.click();
    });
    await page.waitForSelector(".dropdown-list-container", {hidden: true});
    const inserted = await page.$eval(row(seeded.bubble), (row) => ({
        edit: row.querySelector<HTMLTextAreaElement>(".message_edit_content")!.value,
        compose: document.querySelector<HTMLTextAreaElement>("#compose-textarea")!.value,
    }));
    check(
        "a global time and a saved snippet go into the message being edited",
        inserted.edit.includes("<time:") &&
            inserted.edit.includes("Hello from a snippet.") &&
            inserted.compose === "Draft in the compose box.",
        JSON.stringify(inserted),
    );

    // Esc cancels the edit.
    await page.focus(`${row(seeded.bubble)} .message_edit_content`);
    await page.keyboard.press("Escape");
    await wait_for_edit_closed(page, seeded.bubble);
    const after_escape = await message_text(page, seeded.bubble);
    const compose_after = await page.$eval(
        "#compose-textarea",
        (textarea) => (textarea as HTMLTextAreaElement).value,
    );
    check(
        "Esc cancels the edit, and the compose box keeps its text",
        !after_escape.includes("Hello from a snippet.") &&
            compose_after === "Draft in the compose box.",
        JSON.stringify({after_escape, compose_after}),
    );

    // With Enter to send, Enter saves.
    await open_edit(page, seeded.bubble);
    await page.evaluate((selector) => {
        document.querySelector<HTMLTextAreaElement>(selector)!.value = "";
    }, `${row(seeded.bubble)} .message_edit_content`);
    await page.keyboard.type("Edited by Enter.");
    await page.keyboard.press("Enter");
    await wait_for_edit_closed(page, seeded.bubble);
    await wait_for_saved(page, seeded.bubble, "Edited by Enter.");
    check("in the row, Enter saves, as the setting says", true);

    // The original of someone else's message has just Close.
    await page.hover(`${row(seeded.from_iago)} .message_content`);
    await page.click(`${row(seeded.from_iago)} .message-actions-menu-button`);
    await page.waitForSelector(".popover_view_source", {visible: true});
    await page.click(".popover_view_source");
    await page.waitForSelector(`${row(seeded.from_iago)} .message_edit_form`, {visible: true});
    const source = await page.$eval(row(seeded.from_iago), (row) => {
        const field = row.querySelector(".message-edit-field")!.getBoundingClientRect();
        const close = row.querySelector(".message_edit_close")!.getBoundingClientRect();
        return {
            row_buttons: row.querySelectorAll(".message-edit-row-buttons").length,
            close_inside: close.right <= field.right && close.bottom <= field.bottom,
            height: field.height,
        };
    });
    check(
        "the original of a message from someone else is a row with just Close",
        source.row_buttons === 0 && source.close_inside,
        JSON.stringify(source),
    );
    await shot(page, seeded.from_iago, "light-bubble-source");
    await page.click(`${row(seeded.from_iago)} .message_edit_close`);
    await wait_for_edit_closed(page, seeded.from_iago);

    // A time limit for editing shows the time left by the buttons.
    await api(page, "PATCH", "/json/realm", "message_content_edit_limit_seconds=600");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await open_edit(page, seeded.bubble);
    facts = await edit_facts(page, seeded.bubble);
    check(
        "with a time limit, the time left shows by the buttons",
        facts.timer.endsWith("min to edit") && facts.one_row && facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot(page, seeded.bubble, "light-bubble-timer");

    // In a narrow window, the buttons go below the message.
    await page.setViewport({width: 480, height: 900});
    await new Promise((resolve) => setTimeout(resolve, 500));
    facts = await edit_facts(page, seeded.bubble);
    check(
        "in a 480px window, the buttons go below the message, with the time left above Cancel and Save",
        facts.buttons_below_message &&
            facts.timer_above_buttons &&
            facts.overflowing === 0 &&
            JSON.stringify(facts.controls) === JSON.stringify(["Cancel", "Save"]),
        JSON.stringify(facts),
    );
    await shot(page, seeded.bubble, "light-bubble-480");
    await page.click(`${row(seeded.bubble)} .compose-formatting-mode-button`);
    facts = await edit_facts(page, seeded.bubble);
    check(
        "in a 480px window, formatting mode fits too",
        facts.toolbar_shown && facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot(page, seeded.bubble, "light-bubble-480-formatting");
    await page.click(`${row(seeded.bubble)} .message_edit_cancel`);
    await wait_for_edit_closed(page, seeded.bubble);
    await page.setViewport({width: 1280, height: 1000});
    await api(page, "PATCH", "/json/realm", 'message_content_edit_limit_seconds="unlimited"');

    // Every view has the same form.
    const views: [string, string, string][] = [
        ["the Combined feed", "#feed", "classic-feed"],
        [
            "a conversation card",
            `#conversations/channel/${seeded.stream_id}-workshop`,
            "conversation-card",
        ],
        [
            "an open conversation",
            `#narrow/channel/${seeded.stream_id}-workshop/topic/plans`,
            "open-conversation",
        ],
        ["a search by sender", `#narrow/sender/${seeded.desdemona}-Desdemona`, "search"],
    ];
    for (const [name, hash, shot_name] of views) {
        await go_to(page, hash, row(seeded.card));
        await open_edit(page, seeded.card);
        facts = await edit_facts(page, seeded.card);
        check(
            `in ${name}, the edit form is the same row`,
            JSON.stringify(facts.controls) === JSON.stringify(["Cancel", "Save"]) &&
                facts.row_buttons.length === 4 &&
                facts.one_row &&
                Math.abs(facts.field.height - 44) < 0.5 &&
                facts.overflowing === 0,
            JSON.stringify(facts),
        );
        await shot(page, seeded.card, `light-${shot_name}`);
        await page.click(`${row(seeded.card)} .message_edit_cancel`);
        await wait_for_edit_closed(page, seeded.card);
    }

    // The dark theme, and a larger font.
    await api(page, "PATCH", "/json/settings", "color_scheme=2&web_font_size_px=17");
    await page.reload();
    await go_to(page, dm, row(seeded.bubble));
    await open_edit(page, seeded.bubble);
    facts = await edit_facts(page, seeded.bubble);
    check(
        "at 17px, the row grows with the font",
        facts.one_row && facts.field.height > 46 && facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot(page, seeded.bubble, "dark-bubble-17px");
    await page.click(`${row(seeded.bubble)} .compose-formatting-mode-button`);
    await shot(page, seeded.bubble, "dark-bubble-17px-formatting");
    await page.click(`${row(seeded.bubble)} .message_edit_cancel`);
    await wait_for_edit_closed(page, seeded.bubble);
    await api(page, "PATCH", "/json/settings", "color_scheme=3&web_font_size_px=15");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(edit_form_test);
