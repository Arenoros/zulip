import {execSync} from "node:child_process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const shot_prefix = process.env["SHOT_PREFIX"] ?? "compose-row";

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
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
internal_send_private_message(othello, desdemona, "Hello from Othello")
internal_send_private_message(hamlet, desdemona, "Hello from Hamlet")
print("SEEDED " + json.dumps({"othello": othello.id, "hamlet": hamlet.id}))
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

async function shot_compose(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const box = await page.evaluate(() => {
        const rect = document.querySelector("#compose")!.getBoundingClientRect();
        // Room above for popovers and banners.
        const top = Math.max(0, rect.top - 320);
        return {x: rect.left, y: top, width: rect.width, height: rect.bottom - top};
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

type Box = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};

type RowFacts = {
    field: Box;
    textarea: Box;
    row_labels: string[];
    row_buttons: Box[];
    send: Box & {color: string; clickable: boolean};
    send_options: Box;
    toolbar_shown: boolean;
    corner_buttons_shown: boolean;
    drafts_link_shown: boolean;
    formatting_pressed: string | null;
    border_bottom: string;
    line_height: number;
    overflowing: number;
};

async function row_facts(page: Page): Promise<RowFacts> {
    return await page.evaluate(() => {
        const box = (element: Element): Box => {
            const rect = element.getBoundingClientRect();
            return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
            };
        };
        const shown = (element: Element | null): boolean =>
            element !== null && (element as HTMLElement).offsetParent !== null;
        const field = document.querySelector("#compose .messagebox")!;
        const textarea = document.querySelector("textarea#compose-textarea")!;
        const buttons = [
            ...document.querySelectorAll("#compose-row-buttons .compose-row-button"),
        ].filter((button) => shown(button));
        const send = document.querySelector("#compose-send-button")!;
        const field_rect = field.getBoundingClientRect();
        const overflowing = [...document.querySelectorAll("#compose .messagebox *")].filter(
            (element) => {
                const rect = element.getBoundingClientRect();
                return (
                    rect.width > 0 &&
                    (rect.right > field_rect.right + 0.5 || rect.left < field_rect.left - 0.5)
                );
            },
        ).length;
        return {
            field: box(field),
            textarea: box(textarea),
            row_labels: buttons.map((button) => button.getAttribute("aria-label") ?? ""),
            row_buttons: buttons.map((button) => box(button)),
            send: {
                ...box(send),
                color: getComputedStyle(send).color,
                clickable: getComputedStyle(send).pointerEvents !== "none",
            },
            send_options: box(document.querySelector("#send_later")!),
            toolbar_shown: shown(document.querySelector("#message-formatting-controls-container")),
            corner_buttons_shown: [
                ...document.querySelectorAll(
                    "#message-content-container .composebox-buttons button",
                ),
            ].some((button) => shown(button)),
            drafts_link_shown: shown(document.querySelector("#compose-drafts-button")),
            formatting_pressed: document
                .querySelector(".compose-formatting-mode-button")!
                .getAttribute("aria-pressed"),
            border_bottom: getComputedStyle(field).borderBottomColor,
            line_height: Number.parseFloat(getComputedStyle(textarea).lineHeight),
            overflowing,
        };
    });
}

async function toolbar_labels(page: Page): Promise<string[]> {
    return await page.evaluate(() => {
        const items = [
            ...document.querySelectorAll(
                "#message-formatting-controls-container .compose_control_button, #message-formatting-controls-container .compose-toolbar-end .compose-row-button",
            ),
        ].filter((element) => (element as HTMLElement).offsetParent !== null);
        return (
            items
                .map((element) => ({
                    label: element.getAttribute("aria-label") ?? "",
                    rect: element.getBoundingClientRect(),
                }))
                // By rows of the wrapped toolbar, then from left to right.
                .sort(
                    (a, b) =>
                        Math.round(a.rect.top / 16) - Math.round(b.rect.top / 16) ||
                        a.rect.left - b.rect.left,
                )
                .map((item) => item.label)
        );
    });
}

async function textarea_value(page: Page): Promise<string> {
    return await page.$eval("textarea#compose-textarea", (textarea) => textarea.value);
}

function near(a: number, b: number, tolerance = 1): boolean {
    return Math.abs(a - b) <= tolerance;
}

async function compose_row_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as {
        othello: number;
        hamlet: number;
    };
    await common.log_in(page);
    await page.waitForSelector("#message_view_header", {visible: true});
    await page.setViewport({width: 1280, height: 1000});
    await set_setting(page, "color_scheme=3&web_font_size_px=15&web_line_height_percent=140");
    await page.reload();
    await page.waitForSelector("#message_view_header", {visible: true});

    const othello = `#narrow/dm/${seeded.othello}-dm`;
    const hamlet = `#narrow/dm/${seeded.hamlet}-dm`;
    await go_to(page, othello);

    // State 1: one empty row.
    let facts = await row_facts(page);
    check(
        "the row has Formatting, Add emoji, Upload files and More, then the send controls",
        JSON.stringify(facts.row_labels) ===
            JSON.stringify(["Formatting", "Add emoji", "Upload files", "More"]) &&
            facts.row_buttons.every(
                (button) => near(button.width, 32) && near(button.height, 32),
            ) &&
            near(facts.send.width, 32) &&
            near(facts.send_options.width, 20),
        JSON.stringify(facts),
    );
    check(
        "an empty row is 44px tall, with no toolbar, corner buttons, or Drafts link",
        near(facts.field.height, 44) &&
            !facts.toolbar_shown &&
            !facts.corner_buttons_shown &&
            !facts.drafts_link_shown &&
            facts.formatting_pressed === "false",
        JSON.stringify(facts),
    );
    check(
        "Send is inactive while the message is empty",
        !facts.send.clickable,
        JSON.stringify(facts.send),
    );
    const buttons_centered = facts.row_buttons.every((button) =>
        near((button.top + button.bottom) / 2, (facts.field.top + facts.field.bottom) / 2, 1.5),
    );
    check("the buttons are centered in the empty row", buttons_centered, JSON.stringify(facts));
    await shot_compose(page, "light-1-empty");

    // State 2: focused, with text, growing up to six lines.
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("Check the new call window");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("the buttons are at the bottom now");
    facts = await row_facts(page);
    check(
        "with text, Send is active and the focused field has an accent bottom border",
        facts.send.clickable && facts.border_bottom !== "rgb(209, 209, 209)",
        JSON.stringify(facts),
    );
    const two_lines = facts.textarea.height;
    check("two lines grow the field", two_lines > facts.line_height * 2, `${two_lines}`);
    await shot_compose(page, "light-2-text");

    for (let line = 0; line < 8; line += 1) {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Shift");
        await page.keyboard.type(`line ${line}`);
    }
    facts = await row_facts(page);
    const six_lines = facts.line_height * 6 + 20;
    check(
        "the field stops growing at six lines and scrolls",
        near(facts.textarea.height, six_lines, 2) &&
            (await page.$eval(
                "textarea#compose-textarea",
                (textarea) => textarea.scrollHeight > textarea.clientHeight,
            )),
        `${facts.textarea.height} ${six_lines}`,
    );

    // State 3: formatting mode.
    await page.click(".compose-formatting-mode-button");
    await page.waitForSelector("#compose.formatting-mode #message-formatting-controls-container", {
        visible: true,
    });
    facts = await row_facts(page);
    const labels = await toolbar_labels(page);
    const expected_start = [
        "Bold",
        "Italic",
        "Strikethrough",
        "Bulleted list",
        "Numbered list",
        "Quote",
        "Spoiler",
        "Code",
        "Math (LaTeX)",
        "Link",
        "Preview mode",
        "Message formatting",
    ];
    check(
        "formatting mode shows the toolbar in the order of the design, ending with Maximize and Delete draft",
        JSON.stringify(labels.slice(0, expected_start.length)) === JSON.stringify(expected_start) &&
            labels.at(-2) === "Maximize compose box" &&
            labels.at(-1) === "Delete draft",
        JSON.stringify(labels),
    );
    check(
        "formatting mode presses its button and puts the row below the message",
        facts.formatting_pressed === "true" &&
            facts.toolbar_shown &&
            facts.row_buttons.every((button) => button.top >= facts.textarea.bottom - 1),
        JSON.stringify(facts),
    );
    await page.evaluate(() => {
        document.querySelector<HTMLTextAreaElement>("textarea#compose-textarea")!.value = "";
        document
            .querySelector("textarea#compose-textarea")!
            .dispatchEvent(new Event("input", {bubbles: true}));
    });
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("What to check in the new call window:");
    facts = await row_facts(page);
    check(
        "the message field is at least 140px tall",
        facts.textarea.height >= 139.5,
        `${facts.textarea.height}`,
    );
    await shot_compose(page, "light-3-formatting");

    // Enter starts a new line in formatting mode; Ctrl+Enter sends.
    await page.keyboard.press("Enter");
    await page.keyboard.type("- sound");
    const value = await textarea_value(page);
    check(
        "Enter starts a new line in formatting mode",
        value.includes("\n- sound"),
        JSON.stringify(value),
    );
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".message_content")].some((content) =>
                content.textContent?.includes("What to check in the new call window"),
            ),
        {polling: 100},
    );
    await page.waitForFunction(
        () => !document.querySelector("#compose")!.classList.contains("formatting-mode"),
    );
    check(
        "Ctrl+Enter sends, and sending leaves formatting mode",
        (await textarea_value(page)) === "",
    );

    // Moving to another conversation leaves formatting mode.
    await page.click(".compose-formatting-mode-button");
    await go_to(page, hamlet);
    facts = await row_facts(page);
    check(
        "another conversation starts without formatting mode",
        !facts.toolbar_shown && facts.formatting_pressed === "false",
    );
    await go_to(page, othello);

    // Maximize and back.
    await page.click(".compose-formatting-mode-button");
    await page.click(".compose-toolbar-end .maximize-composebox-button");
    await page.waitForSelector("#compose.compose-fullscreen");
    const collapse_shown = await page.$eval(
        ".compose-toolbar-end .collapse-composebox-button",
        (button) => (button as HTMLElement).offsetParent !== null,
    );
    check("Maximize fills the view and offers Collapse", collapse_shown);
    await page.click(".compose-toolbar-end .collapse-composebox-button");
    await page.waitForFunction(
        () => !document.querySelector("#compose")!.classList.contains("compose-fullscreen"),
    );
    check("Collapse goes back to formatting mode", true);

    // Preview, then leaving formatting mode, leaves the preview.
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("**bold** text");
    await page.click("#compose .markdown_preview");
    await page.waitForSelector("#compose.preview_mode");
    await page.click(".compose-formatting-mode-button");
    await page.waitForFunction(
        () => !document.querySelector("#compose")!.classList.contains("preview_mode"),
    );
    check(
        "leaving formatting mode leaves the preview",
        (await textarea_value(page)) === "**bold** text",
    );

    // Delete draft.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.click(".compose-formatting-mode-button");
    await page.click(".compose-delete-draft-button");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const draft_kept = await page.evaluate(() =>
        Object.values(localStorage).some((value) => value.includes("**bold** text")),
    );
    check(
        "Delete draft empties the field and deletes its draft",
        (await textarea_value(page)) === "" && !draft_kept,
        `${draft_kept}`,
    );

    // The emoji button opens the emoji picker.
    await page.click("#compose-row-buttons .emoji_map");
    await page.waitForSelector(".emoji-picker-popover", {visible: true});
    check("the emoji button opens the emoji picker", true);
    await page.keyboard.press("Escape");

    // A narrow window.
    await page.setViewport({width: 480, height: 900});
    await go_to(page, othello);
    facts = await row_facts(page);
    check(
        "at 480px the row fits with room for the message",
        facts.overflowing === 0 && facts.textarea.width > 150,
        JSON.stringify(facts),
    );
    await shot_compose(page, "light-narrow-1");
    await page.click(".compose-formatting-mode-button");
    facts = await row_facts(page);
    check(
        "at 480px the toolbar wraps without overflowing",
        facts.overflowing === 0,
        JSON.stringify(facts),
    );
    await shot_compose(page, "light-narrow-3");
    await page.setViewport({width: 1280, height: 1000});

    // Dark theme.
    await set_setting(page, "color_scheme=2");
    await page.reload();
    await go_to(page, othello);
    await shot_compose(page, "dark-1-empty");
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("Check the new call window");
    await shot_compose(page, "dark-2-text");
    await page.click(".compose-formatting-mode-button");
    await shot_compose(page, "dark-3-formatting");

    // 17px font.
    await set_setting(page, "color_scheme=3&web_font_size_px=17");
    await page.reload();
    await go_to(page, othello);
    facts = await row_facts(page);
    check("at 17px the empty row scales up", facts.field.height > 46, JSON.stringify(facts.field));
    await shot_compose(page, "light-17px");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(compose_row_test);
