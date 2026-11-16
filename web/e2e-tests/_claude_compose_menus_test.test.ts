import {execSync} from "node:child_process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const shot_prefix = process.env["SHOT_PREFIX"] ?? "compose-menus";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const seed_script = String.raw`import json

from zerver.actions.message_send import internal_send_private_message
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
internal_send_private_message(othello, desdemona, "Hello from Othello")
print("SEEDED " + json.dumps({"othello": othello.id}))
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
        throw new Error(`Changing the settings ${body} failed with ${status}`);
    }
}

async function go_to(page: Page, hash: string): Promise<void> {
    await page.evaluate((hash) => {
        window.location.hash = hash;
    }, hash);
    await page.waitForSelector("#compose.compose-for-view", {visible: true});
    await new Promise((resolve) => setTimeout(resolve, 500));
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const box = await page.evaluate(() => {
        const rect = document.querySelector("#compose")!.getBoundingClientRect();
        const top = Math.max(0, rect.top - 360);
        return {x: rect.left, y: top, width: rect.width, height: rect.bottom - top};
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

type Rect = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};

async function rect_of(page: Page, selector: string): Promise<Rect | undefined> {
    return await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (element === null) {
            return undefined;
        }
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };
    }, selector);
}

async function open_plus_menu(page: Page): Promise<void> {
    // A dialog closing still covers the page while it fades out.
    await page.waitForSelector(".micromodal.modal--open", {hidden: true});
    await page.click(".compose-plus-menu-button");
    await page.waitForSelector("#compose-plus-menu-popover", {visible: true});
}

async function close_popovers(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 300));
}

// Whether a popover opened next to the "+" button, which it would not
// if it were anchored to a hidden element.
async function near_plus_button(page: Page, selector: string): Promise<boolean> {
    const plus = await rect_of(page, ".compose-plus-menu-button");
    const popover = await rect_of(page, selector);
    return (
        plus !== undefined &&
        popover !== undefined &&
        popover.width > 0 &&
        popover.bottom <= plus.top + 2 &&
        plus.top - popover.bottom < 60 &&
        popover.left < plus.right + 200 &&
        popover.right > plus.left - 400
    );
}

async function compose_menus_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as {othello: number};
    await common.log_in(page);
    await page.waitForSelector("#message_view_header", {visible: true});
    await page.setViewport({width: 1280, height: 1000});
    await set_setting(page, "color_scheme=3&web_font_size_px=15&web_line_height_percent=140");
    await page.reload();
    await page.waitForSelector("#message_view_header", {visible: true});
    const othello = `#narrow/dm/${seeded.othello}-dm`;
    await go_to(page, othello);

    // The "+" menu, with an empty message.
    await open_plus_menu(page);
    const menu = await page.evaluate(() => {
        const popover = document.querySelector("#compose-plus-menu-popover")!;
        const button = document.querySelector(".compose-plus-menu-button")!;
        return {
            labels: [...popover.querySelectorAll(".popover-menu-label")].map((label) =>
                label.textContent?.trim(),
            ),
            disabled: popover.querySelectorAll(".compose-plus-menu-item-disabled").length,
            width: popover.getBoundingClientRect().width,
            item_heights: [...popover.querySelectorAll(".popover-menu-link")].map(
                (link) => link.getBoundingClientRect().height,
            ),
            expanded: button.getAttribute("aria-expanded"),
            active: button.classList.contains("compose-row-button-active"),
        };
    });
    check(
        "the + menu has Poll, To-do list, Global time and Saved snippets, 260px wide, 40px items",
        JSON.stringify(menu.labels) ===
            JSON.stringify(["Poll", "To-do list", "Global time", "Saved snippets"]) &&
            menu.disabled === 0 &&
            Math.abs(menu.width - 260) <= 2 &&
            menu.item_heights.every((height) => height >= 39.5),
        JSON.stringify(menu),
    );
    check(
        "the + button looks pressed while its menu is open",
        menu.expanded === "true" && menu.active,
    );
    check(
        "the + menu opens above the + button",
        await near_plus_button(page, "#compose-plus-menu-popover"),
    );
    await shot(page, "light-plus-menu");

    // Poll and to-do list open their dialogs.
    await page.click(".compose-plus-menu-poll");
    await page.waitForSelector("#add-poll-modal", {visible: true});
    check("Poll opens the poll dialog", true);
    await close_popovers(page);
    await page.waitForSelector("#add-poll-modal", {hidden: true});

    // Esc while the dialog is still opening closes it, and stays in
    // the conversation.
    await open_plus_menu(page);
    await page.click(".compose-plus-menu-poll");
    await page.waitForSelector("#add-poll-modal");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".micromodal", {hidden: true});
    await new Promise((resolve) => setTimeout(resolve, 500));
    const hash_after_escape = await page.evaluate(() => window.location.hash);
    check(
        "Esc while a dialog opens closes it and stays in the conversation",
        decodeURIComponent(hash_after_escape) === decodeURIComponent(othello),
        hash_after_escape,
    );
    await open_plus_menu(page);
    await page.click(".compose-plus-menu-todo-list");
    await page.waitForSelector("#add-todo-modal", {visible: true});
    check("To-do list opens the to-do list dialog", true);
    await close_popovers(page);
    await page.waitForSelector("#add-todo-modal", {hidden: true});

    // Global time opens the date picker by the + button.
    await open_plus_menu(page);
    await page.click(".compose-plus-menu-global-time");
    await page.waitForSelector(".flatpickr-calendar.open", {visible: true});
    const calendar = await rect_of(page, ".flatpickr-calendar.open");
    const plus = await rect_of(page, ".compose-plus-menu-button");
    check(
        "Global time opens the date picker by the + button",
        calendar !== undefined &&
            plus !== undefined &&
            calendar.width > 0 &&
            Math.abs((calendar.left + calendar.right) / 2 - (plus.left + plus.right) / 2) < 200,
        JSON.stringify({calendar, plus}),
    );
    await page.click(".flatpickr-calendar.open .flatpickr-confirm");
    await page.waitForFunction(() =>
        document
            .querySelector<HTMLTextAreaElement>("textarea#compose-textarea")!
            .value.includes("<time:"),
    );
    check("picking a time inserts it into the message", true);

    // With text, poll and to-do list are inactive and say why.
    await open_plus_menu(page);
    const notes = await page.$$eval(
        "#compose-plus-menu-popover .compose-plus-menu-note",
        (elements) => elements.map((element) => element.textContent?.trim()),
    );
    await page.click(".compose-plus-menu-poll");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const poll_dialog_shown = await page.evaluate(
        () => document.querySelector<HTMLElement>("#add-poll-modal")?.offsetParent != null,
    );
    check(
        "with text, Poll and To-do list are inactive and say why",
        JSON.stringify(notes) ===
            JSON.stringify([
                "A poll must be an entire message.",
                "A to-do list must be an entire message.",
            ]) && !poll_dialog_shown,
        JSON.stringify(notes),
    );
    await shot(page, "light-plus-menu-with-text");
    await close_popovers(page);

    // Saved snippets open by the + button, from the menu and with the keyboard.
    const console_errors: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") {
            console_errors.push(message.text());
        }
    });
    await open_plus_menu(page);
    await page.click(".compose-plus-menu-saved-snippets");
    await page.waitForSelector(".dropdown-list-container", {visible: true});
    check(
        "Saved snippets open by the + button",
        await near_plus_button(page, "[data-tippy-root] .dropdown-list-container"),
    );
    await shot(page, "light-saved-snippets");
    await close_popovers(page);
    await page.click("textarea#compose-textarea");
    await page.keyboard.down("Control");
    await page.keyboard.press("Quote");
    await page.keyboard.up("Control");
    await page.waitForSelector(".dropdown-list-container", {visible: true});
    check(
        "Ctrl+' opens the saved snippets by the + button",
        await near_plus_button(page, "[data-tippy-root] .dropdown-list-container"),
    );
    check(
        "opening the saved snippets reports no errors",
        console_errors.length === 0,
        JSON.stringify(console_errors),
    );
    await close_popovers(page);

    // Formatting mode no longer has these buttons.
    await page.click(".compose-formatting-mode-button");
    const toolbar = await page.$$eval(
        "#message-formatting-controls-container .compose_control_button",
        (buttons) =>
            buttons
                .filter((button) => (button as HTMLElement).offsetParent !== null)
                .map((button) => button.getAttribute("aria-label")),
    );
    check(
        "the formatting toolbar no longer has poll, to-do list, global time or saved snippets",
        !toolbar.some((label) =>
            ["Add poll", "Add to-do list", "Add global time", "Add saved snippet"].includes(
                label ?? "",
            ),
        ),
        JSON.stringify(toolbar),
    );
    await page.click(".compose-formatting-mode-button");

    // The send options menu.
    await page.click("#send_later i");
    await page.waitForSelector("#send_later_popover", {visible: true});
    const send_menu = await page.evaluate(() => {
        const popover = document.querySelector("#send_later_popover")!;
        const drafts = popover.querySelector<HTMLElement>(".view_contextual_drafts");
        return {
            drafts_shown: drafts !== null && drafts.offsetParent !== null,
            for_view: popover.classList.contains("compose-row-send-menu"),
            width: popover.getBoundingClientRect().width,
            items: [...popover.querySelectorAll(".popover-menu-label, .enter_sends_major")].map(
                (label) => label.textContent?.replaceAll(/\s+/g, " ").trim(),
            ),
        };
    });
    check(
        "the send options keep every item, with View drafts, 280px wide",
        send_menu.for_view &&
            Math.abs(send_menu.width - 280) <= 2 &&
            send_menu.items.length >= 5 &&
            send_menu.items.some((item) => item?.startsWith("Schedule message")) &&
            send_menu.items.some((item) => item?.startsWith("View scheduled messages")) &&
            send_menu.items.some((item) => item?.startsWith("View drafts")) &&
            send_menu.drafts_shown,
        JSON.stringify(send_menu),
    );
    await shot(page, "light-send-menu");
    await close_popovers(page);

    // With the keyboard.
    await page.focus(".compose-plus-menu-button");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#compose-plus-menu-popover", {visible: true});
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(() => document.activeElement?.className ?? "");
    check("arrow keys move through the + menu", focused.includes("popover-menu-link"), focused);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#compose-plus-menu-popover", {hidden: true});
    check("Esc closes the + menu", true);

    // The classic compose box keeps its send options as they were.
    await page.evaluate(() => {
        window.location.hash = "#feed";
    });
    await page.waitForSelector("#compose.compose-for-view", {hidden: true});
    await page.keyboard.press("KeyC");
    await page.waitForSelector("#compose-textarea", {visible: true});
    await page.click("#send_later i");
    await page.waitForSelector("#send_later_popover", {visible: true});
    const classic_for_view = await page.$eval("#send_later_popover", (popover) =>
        popover.classList.contains("compose-row-send-menu"),
    );
    check("the classic compose box keeps its send options menu", !classic_for_view);
    await close_popovers(page);

    // Dark theme.
    await set_setting(page, "color_scheme=2");
    await page.reload();
    await go_to(page, othello);
    await open_plus_menu(page);
    await shot(page, "dark-plus-menu");
    await close_popovers(page);
    await page.click("#send_later i");
    await page.waitForSelector("#send_later_popover", {visible: true});
    await shot(page, "dark-send-menu");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(compose_menus_test);
