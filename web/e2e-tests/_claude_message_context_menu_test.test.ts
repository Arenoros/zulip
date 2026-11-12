import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const menu_selector = "#message-actions-menu-dropdown";

type Point = {x: number; y: number; row_id: string};
type Box = {left: number; top: number; right: number; bottom: number};

// A point inside the text of the last message containing `text`.
async function message_point(page: Page, text: string, selector = "p"): Promise<Point> {
    const point = await page.evaluate(
        (text, selector) => {
            const rows = [...document.querySelectorAll(".focused-message-list .message_row")];
            const row = rows.findLast((row) =>
                row.querySelector(".message_content")?.textContent.includes(text),
            );
            if (!row) {
                return undefined;
            }
            row.scrollIntoView({block: "center"});
            const rect = row.querySelector(`.message_content ${selector}`)!.getBoundingClientRect();
            return {x: rect.left + 12, y: rect.top + rect.height / 2, row_id: row.id};
        },
        text,
        selector,
    );
    if (point === undefined) {
        throw new Error(`No message containing ${text}`);
    }
    return point;
}

// Waits for the menu to finish opening, so that its box is the final one.
async function open_menu_box(page: Page): Promise<Box> {
    await page.waitForSelector(menu_selector, {visible: true});
    await page.evaluate(() => {
        delete document.body.dataset["contextMenuBox"];
    });
    await page.waitForFunction(
        (menu_selector) => {
            const box = document.querySelector(menu_selector)?.closest(".tippy-box");
            if (!box) {
                return false;
            }
            const rect = box.getBoundingClientRect();
            const current = `${rect.left},${rect.top},${rect.width},${rect.height}`;
            const previous = document.body.dataset["contextMenuBox"];
            document.body.dataset["contextMenuBox"] = current;
            return previous === current;
        },
        {polling: 100},
        menu_selector,
    );
    return (await menu_box(page))!;
}

async function menu_box(page: Page): Promise<Box | undefined> {
    return await page.evaluate((menu_selector) => {
        const box = document.querySelector(menu_selector)?.closest(".tippy-box");
        if (!box) {
            return undefined;
        }
        const rect = box.getBoundingClientRect();
        return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
    }, menu_selector);
}

async function menu_state(
    page: Page,
): Promise<{prevented: string | undefined; menu_row: string; selected_row: string}> {
    return await page.evaluate(() => ({
        prevented: document.body.dataset["contextMenuPrevented"],
        menu_row: document.querySelector(".focused-message-list .has_actions_popover")?.id ?? "",
        selected_row: document.querySelector(".focused-message-list .selected_message")?.id ?? "",
    }));
}

async function close_menu(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForSelector(menu_selector, {hidden: true});
}

function near_cursor(box: Box, point: Point): boolean {
    const horizontal = Math.abs(box.left - point.x) <= 16;
    const below = box.top >= point.y - 1 && box.top - point.y <= 24;
    const above = box.bottom <= point.y + 1 && point.y - box.bottom <= 24;
    return horizontal && (below || above);
}

async function check_menu_opens(page: Page, view: string, text: string): Promise<void> {
    const point = await message_point(page, text);
    await page.mouse.click(point.x, point.y, {button: "right"});
    const box = await open_menu_box(page);
    const state = await menu_state(page);
    check(`${view}: menu opens at the cursor`, near_cursor(box, point), JSON.stringify({box, point}));
    check(`${view}: browser menu is suppressed`, state.prevented === "true");
    check(`${view}: menu belongs to the clicked message`, state.menu_row === point.row_id);
    check(`${view}: clicked message is selected`, state.selected_row === point.row_id);
    const focus_in_menu = await page.evaluate(
        () => document.activeElement?.closest("[data-tippy-root]") !== null,
    );
    check(`${view}: a mouse open does not move focus into the menu`, !focus_in_menu);
    await page.screenshot({
        path: `var/puppeteer/context-menu-${view}.png`,
        captureBeyondViewport: false,
    });
    await close_menu(page);
}

async function check_browser_menu_kept(page: Page, name: string, point: Point): Promise<void> {
    await page.evaluate(() => {
        delete document.body.dataset["contextMenuPrevented"];
    });
    await page.mouse.click(point.x, point.y, {button: "right"});
    await page.waitForFunction(
        () => document.body.dataset["contextMenuPrevented"] !== undefined,
    );
    const state = await menu_state(page);
    const box = await menu_box(page);
    check(`${name}: browser menu is kept`, state.prevented === "false");
    check(`${name}: message menu stays closed`, box === undefined);
}

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);
    await page.click("#left-sidebar-navigation-list .top_left_all_messages");
    const message_list_id = await common.get_current_msg_list_id(page, true);
    await page.waitForSelector(
        `.message-list[data-message-list-id='${message_list_id}'] .message_row`,
        {visible: true},
    );
    await page.evaluate(() => {
        window.addEventListener("contextmenu", (e) => {
            document.body.dataset["contextMenuPrevented"] = String(e.defaultPrevented);
        });
    });

    await common.send_message(page, "stream", {
        stream_name: "Verona",
        topic: "context menu",
        content: "first plain message",
    });
    await common.send_message(
        page,
        "stream",
        {
            stream_name: "Verona",
            topic: "context menu",
            content: "second message with https://example.com/page inside",
        },
        false,
    );
    await page.waitForFunction(() =>
        [...document.querySelectorAll(".focused-message-list .message_content")].some((element) =>
            element.textContent.includes("second message with"),
        ),
    );
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});

    // Channel topic view.
    await check_menu_opens(page, "topic", "first plain message");

    // A second right-click moves the menu to the other message.
    const first = await message_point(page, "first plain message");
    await page.mouse.click(first.x, first.y, {button: "right"});
    // The open menu covers the start of the next message, so aim past
    // it, and past the link, which keeps the browser's menu.
    const open_box = await open_menu_box(page);
    const second_text = await message_point(page, "second message with");
    const link_right = await page.$eval(
        `#${second_text.row_id} .message_content a`,
        (link) => link.getBoundingClientRect().right,
    );
    const second = {...second_text, x: Math.max(open_box.right, link_right) + 15};
    await page.mouse.click(second.x, second.y, {button: "right"});
    await page.waitForFunction(
        (row_id) => document.querySelector(".focused-message-list .has_actions_popover")?.id === row_id,
        {},
        second.row_id,
    );
    const moved_box = await open_menu_box(page);
    check(
        "second right-click moves the menu",
        near_cursor(moved_box, second),
        JSON.stringify({moved_box, second}),
    );
    await close_menu(page);

    // Links keep the browser menu.
    const link = await message_point(page, "second message with", "a");
    await check_browser_menu_kept(page, "link", link);

    // Selected text keeps the browser menu.
    await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".focused-message-list .message_row")];
        const row = rows.findLast((row) =>
            row.querySelector(".message_content")?.textContent.includes("first plain message"),
        )!;
        const range = document.createRange();
        range.selectNodeContents(row.querySelector(".message_content p")!);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
    });
    await check_browser_menu_kept(page, "selected text", first);
    await page.evaluate(() => {
        document.getSelection()!.removeAllRanges();
    });

    // A selection elsewhere on the page does not block the menu.
    await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#left-sidebar .top_left_inbox")!);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
    });
    await page.mouse.click(first.x, first.y, {button: "right"});
    await page.waitForSelector(menu_selector, {visible: true});
    check("selection outside the message does not block the menu", true);
    await close_menu(page);
    await page.evaluate(() => {
        document.getSelection()!.removeAllRanges();
    });

    // The ⋮ button still anchors the menu to itself after a right-click open.
    const button_box = await page.evaluate((row_id) => {
        const row = document.querySelector(`#${CSS.escape(row_id)}`)!;
        const rect = row.querySelector(".message-actions-menu-button")!.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    }, first.row_id);
    await page.mouse.move(first.x, first.y);
    await page.mouse.click(button_box.x, button_box.y);
    const button_menu = await open_menu_box(page);
    const menu_center = (button_menu.left + button_menu.right) / 2;
    check(
        "the ⋮ button opens the menu under the button",
        Math.abs(menu_center - button_box.x) <= 30,
        JSON.stringify({button_menu, button_box}),
    );
    await close_menu(page);

    // The keyboard shortcut still focuses the first item.
    await page.keyboard.press("KeyI");
    await page.waitForSelector(menu_selector, {visible: true});
    const keyboard_focus_in_menu = await page.evaluate(
        () => document.activeElement?.closest("[data-tippy-root]") !== null,
    );
    check("the keyboard shortcut focuses the menu", keyboard_focus_in_menu);
    await close_menu(page);

    // Near the right edge the menu stays inside the window.
    const edge = await page.evaluate((row_id) => {
        const row = document.querySelector(`#${CSS.escape(row_id)}`)!;
        const rect = row.querySelector(".message_content p")!.getBoundingClientRect();
        return {x: rect.right - 6, y: rect.top + rect.height / 2, row_id};
    }, first.row_id);
    await page.mouse.click(edge.x, edge.y, {button: "right"});
    const edge_box = await open_menu_box(page);
    const window_width = await page.evaluate(() => window.innerWidth);
    check(
        "menu near the right edge fits in the window",
        edge_box.left >= 0 && edge_box.right <= window_width,
        JSON.stringify({edge_box, window_width}),
    );
    await close_menu(page);

    // Direct message view.
    await common.send_message(page, "private", {
        recipient: "cordelia@zulip.com",
        content: "direct plain message",
    });
    await page.waitForSelector(".focused-message-list .private-message", {visible: true});
    await check_menu_opens(page, "direct", "direct plain message");

    // Combined feed.
    await page.goto("http://zulip.zulipdev.com:9981/#feed");
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".focused-message-list .message_content")].some(
                (element) => element.textContent.includes("first plain message"),
            ),
    );
    await page.evaluate(() => {
        window.addEventListener("contextmenu", (e) => {
            document.body.dataset["contextMenuPrevented"] = String(e.defaultPrevented);
        });
    });
    await check_menu_opens(page, "feed", "first plain message");

    // Short window: the menu fits neither below nor above the cursor.
    await page.setViewport({width: 1400, height: 520});
    await page.waitForFunction(() => window.innerHeight === 520);
    const short = await message_point(page, "first plain message");
    await page.mouse.click(short.x, short.y, {button: "right"});
    const short_box = await open_menu_box(page);
    check(
        "menu stays inside a short window",
        short_box.top >= 0 && short_box.bottom <= 520 && Math.abs(short_box.left - short.x) <= 16,
        JSON.stringify({short_box, short}),
    );
    check(
        "cursor does not rest on the menu in a short window",
        short.x < short_box.left,
        JSON.stringify({short_box, short}),
    );
    await page.screenshot({
        path: "var/puppeteer/context-menu-short.png",
        captureBeyondViewport: false,
    });
    await close_menu(page);

    // Narrow window.
    await page.setViewport({width: 480, height: 800});
    await page.waitForFunction(() => window.innerWidth === 480);
    const narrow = await message_point(page, "first plain message");
    await page.mouse.click(narrow.x, narrow.y, {button: "right"});
    const narrow_box = await open_menu_box(page);
    check(
        "menu fits in a narrow window",
        narrow_box.left >= 0 && narrow_box.right <= 480,
        JSON.stringify(narrow_box),
    );
    check(
        "menu in a narrow window stays at the cursor",
        near_cursor(narrow_box, narrow),
        JSON.stringify({narrow_box, narrow}),
    );
    await page.screenshot({
        path: "var/puppeteer/context-menu-narrow.png",
        captureBeyondViewport: false,
    });
    await close_menu(page);
    await page.setViewport({width: 1400, height: 1024});

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
