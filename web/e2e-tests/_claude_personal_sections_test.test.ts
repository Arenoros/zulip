import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

async function api_request(
    page: Page,
    method: string,
    url: string,
    body: string,
): Promise<void> {
    await page.evaluate(
        async (method, url, body) => {
            const csrf_token =
                document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                    ?.value ?? "";
            await fetch(url, {
                method,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": csrf_token,
                },
                body,
            });
        },
        method,
        url,
        body,
    );
}

async function api_patch(page: Page, url: string, body: string): Promise<void> {
    await api_request(page, "PATCH", url, body);
}

async function sidebar_clip(page: Page, name: string): Promise<void> {
    const box = await page.evaluate(() => {
        const rect = document.querySelector("#left-sidebar")!.getBoundingClientRect();
        return {x: rect.x, y: rect.y, width: rect.width + 260, height: Math.min(rect.height, 700)};
    });
    // Capturing beyond the viewport fires resize events, which close popovers.
    await page.screenshot({
        path: `var/puppeteer/${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function section_names(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
        [...document.querySelectorAll("#direct-messages-list .dm-list-section-name")].map(
            (element) => element.textContent.trim(),
        ),
    );
}

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);
    await page.waitForSelector("#direct-messages-section-header", {visible: true});
    await sidebar_clip(page, "ps-01-before");

    const cordelia = await common.get_user_id_from_name(page, common.fullname.cordelia);
    const othello = await common.get_user_id_from_name(page, common.fullname.othello);
    const hamlet = await common.get_user_id_from_name(page, common.fullname.hamlet);
    const group = [cordelia!, hamlet!].toSorted((a, b) => a - b);

    // A conversation with messages stays in the list when it is not in a section.
    await api_request(
        page,
        "POST",
        "/json/messages",
        `type=direct&to=${encodeURIComponent(JSON.stringify([cordelia]))}&content=hello`,
    );
    await page.waitForSelector(
        `#direct-messages-list .dm-list-item[data-user-ids-string="${cordelia}"]`,
    );
    check(
        "no section headings without sections",
        (await page.$("#direct-messages-list .dm-list-section-header")) === null,
    );
    await sidebar_clip(page, "ps-01b-one-conversation");

    // The Channels tab shows the usual sidebar, with the controls of
    // the direct messages header on its row.
    const dm_header = await page.evaluate(() => {
        const header = document
            .querySelector("#direct-messages-section-header")!
            .getBoundingClientRect();
        const controls = document
            .querySelector("#direct-messages-section-header .left-sidebar-controls")!
            .getBoundingClientRect();
        const tabs = [...document.querySelectorAll("#left-sidebar-tabs .ind-tab")].map(
            (tab) => `${tab.textContent.trim()}:${tab.classList.contains("selected")}`,
        );
        return {
            header_top: header.top,
            header_h: header.height,
            controls_top: controls.top,
            controls_h: controls.height,
            tabs,
        };
    });
    console.log("dm header:", JSON.stringify(dm_header));
    check(
        "direct messages header controls are on the header row",
        dm_header.controls_top >= dm_header.header_top &&
            dm_header.controls_top + dm_header.controls_h <=
                dm_header.header_top + dm_header.header_h &&
            dm_header.header_h < 40,
        JSON.stringify(dm_header),
    );
    check(
        "Channels tab is selected by default",
        dm_header.tabs.join(",") === "Channels:true,Chats:false",
        dm_header.tabs.join(","),
    );
    // Mark a few channel messages and the direct message unread.
    const unread_ids = await page.evaluate(async () => {
        const fetch_ids = async (narrow: unknown[]): Promise<number[]> => {
            const params = new URLSearchParams({
                anchor: "newest",
                num_before: "3",
                num_after: "0",
                narrow: JSON.stringify(narrow),
            });
            const response = await fetch(`/json/messages?${params.toString()}`);
            const data = (await response.json()) as {messages: {id: number}[]};
            return data.messages.map((message) => message.id);
        };
        return [
            ...(await fetch_ids([{operator: "channel", operand: "Verona"}])),
            ...(await fetch_ids([{operator: "is", operand: "dm"}])).slice(-1),
        ];
    });
    await api_request(
        page,
        "POST",
        "/json/messages/flags",
        `op=remove&flag=read&messages=${encodeURIComponent(JSON.stringify(unread_ids))}`,
    );
    await page.waitForFunction(
        () =>
            document
                .querySelector('#left-sidebar-tabs .ind-tab[data-tab-key="chats"] .unread_count')
                ?.textContent.trim() === "1",
    );

    const tab_counts = await page.evaluate(() => {
        const count = (selector: string): string =>
            document.querySelector<HTMLElement>(selector)!.offsetParent === null
                ? ""
                : document.querySelector(selector)!.textContent.trim();
        const box = (selector: string): DOMRect =>
            document.querySelector(selector)!.getBoundingClientRect();
        const tab = box('#left-sidebar-tabs .ind-tab[data-tab-key="channels"]');
        const badge = box('#left-sidebar-tabs .ind-tab[data-tab-key="channels"] .unread_count');
        return {
            channels: count('#left-sidebar-tabs .ind-tab[data-tab-key="channels"] .unread_count'),
            chats: count('#left-sidebar-tabs .ind-tab[data-tab-key="chats"] .unread_count'),
            dm_header: count("#direct-messages-section-header .unread_count"),
            tab_h: tab.height,
            badge_inside: badge.top >= tab.top && badge.bottom <= tab.bottom,
        };
    });
    console.log("tab counts:", JSON.stringify(tab_counts));
    check(
        "Channels tab shows the unread count of channels",
        /^\d+$/.test(tab_counts.channels) && tab_counts.badge_inside,
        JSON.stringify(tab_counts),
    );
    check(
        "Chats tab shows the unread count of direct messages",
        tab_counts.chats === tab_counts.dm_header,
        JSON.stringify(tab_counts),
    );
    await page.screenshot({
        path: "var/puppeteer/ps-01c-tab-counts.png",
        clip: {x: 0, y: 80, width: 340, height: 80},
        captureBeyondViewport: false,
    });

    await page.hover(`#direct-messages-list .dm-list-item[data-user-ids-string="${cordelia}"]`);
    check(
        "conversations have no menu in the Channels tab",
        await page.$eval(
            `#direct-messages-list .dm-list-item[data-user-ids-string="${cordelia}"] .dm-sidebar-menu-icon`,
            (element) => getComputedStyle(element).display === "none",
        ),
    );

    const sections = [
        {name: "Project", conversations: [[cordelia], group]},
        {name: "Notes", conversations: [[]]},
        {
            name: "A very long section name that gets cut off with ellipsis",
            conversations: [[othello]],
        },
    ];
    await api_patch(
        page,
        "/json/users/me/personal_sections",
        `conversation_sections=${encodeURIComponent(JSON.stringify(sections))}`,
    );
    // Sections are only shown in the Chats tab.
    await page.waitForFunction(
        () => document.querySelectorAll("#direct-messages-list .dm-list-item").length === 1,
    );
    check(
        "Channels tab shows no sections",
        (await page.$("#direct-messages-list .dm-list-section-header")) === null,
    );
    await page.click('#left-sidebar-tabs .ind-tab[data-tab-key="chats"]');
    await page.waitForFunction(
        () =>
            document.querySelectorAll("#direct-messages-list .dm-list-personal-section-header")
                .length === 3,
    );
    check("live update shows three sections", true);
    const hidden_in_chats = await page.evaluate(() =>
        [
            "#left-sidebar-navigation-area",
            "#direct-messages-section-header",
            "#streams_list",
            "#add_streams_button",
        ].map((selector) => document.querySelector<HTMLElement>(selector)!.offsetParent === null),
    );
    check(
        "Chats tab hides views, the direct messages header and channels",
        hidden_in_chats.every(Boolean),
        JSON.stringify(hidden_in_chats),
    );
    console.log("section names:", JSON.stringify(await section_names(page)));
    await common.screenshot(page, "ps-02-sections-full");
    await sidebar_clip(page, "ps-02-sections");

    // Alignment of the section header with conversation rows.
    const metrics = await page.evaluate(() => {
        const rect = (selector: string): DOMRect | undefined =>
            document.querySelector(selector)?.getBoundingClientRect();
        const header = rect("#direct-messages-list .dm-list-personal-section-header")!;
        const toggle = rect("#direct-messages-list .dm-list-section-toggle")!;
        const name = rect("#direct-messages-list .dm-list-section-name")!;
        const row = rect("#direct-messages-list .dm-list-item")!;
        const row_icon = rect("#direct-messages-list .dm-list-item .conversation-partners-icon")!;
        const row_name = rect("#direct-messages-list .dm-list-item .conversation-partners")!;
        const dm_header_toggle = rect("#toggle-direct-messages-section-icon")!;
        const long_name = [
            ...document.querySelectorAll("#direct-messages-list .dm-list-section-name"),
        ].at(-1)!;
        const other_header = [
            ...document.querySelectorAll("#direct-messages-list .dm-list-section-header"),
        ].find((element) => !element.classList.contains("dm-list-personal-section-header"));
        return {
            header: {x: header.x, w: header.width, h: header.height},
            toggle: {x: toggle.x, w: toggle.width, cx: toggle.x + toggle.width / 2},
            name_x: name.x,
            row: {x: row.x, w: row.width, h: row.height},
            row_icon_cx: row_icon.x + row_icon.width / 2,
            row_name_x: row_name.x,
            dm_header_toggle_cx: dm_header_toggle.x + dm_header_toggle.width / 2,
            long_name_overflows: long_name.scrollWidth > long_name.clientWidth,
            long_name_right: long_name.getBoundingClientRect().right,
            header_right: header.right,
            has_other_header: other_header !== undefined,
            other_header_text: other_header?.textContent.trim(),
        };
    });
    console.log("metrics:", JSON.stringify(metrics));
    check(
        "section toggle is centered over conversation icons",
        Math.abs(metrics.toggle.cx - metrics.row_icon_cx) <= 1,
        `${metrics.toggle.cx} vs ${metrics.row_icon_cx}`,
    );
    check(
        "section name is aligned with conversation names",
        Math.abs(metrics.name_x - metrics.row_name_x) <= 1,
        `${metrics.name_x} vs ${metrics.row_name_x}`,
    );
    check(
        "section header is as wide as a conversation row",
        metrics.header.x === metrics.row.x && metrics.header.w === metrics.row.w,
    );
    check("long section name is cut off inside the header", metrics.long_name_overflows);
    check("long section name stays inside the header", metrics.long_name_right <= metrics.header_right);

    // Hover a conversation in a section and open its menu.
    const row_selector = `#direct-messages-list .dm-list-item[data-user-ids-string="${cordelia}"]`;
    await page.hover(row_selector);
    await page.waitForSelector(`${row_selector} .dm-sidebar-menu-icon`, {visible: true});
    await sidebar_clip(page, "ps-03-row-hover");
    await page.click(`${row_selector} .dm-sidebar-menu-icon`);
    await page.waitForSelector(".dm-popover-new-section", {visible: true});
    await sidebar_clip(page, "ps-04-conversation-menu");
    const url_before = page.url();

    // Move the conversation to another section.
    await page.click('.dm-popover-move-to-section[data-section-name="Notes"]');
    await page.waitForFunction(
        (cordelia) => {
            const headers = [
                ...document.querySelectorAll("#direct-messages-list .dm-list > li"),
            ];
            const notes = headers.findIndex(
                (li) => li.getAttribute("data-section-name") === "Notes",
            );
            const row = headers.findIndex(
                (li) => li.getAttribute("data-user-ids-string") === String(cordelia),
            );
            return notes !== -1 && row > notes;
        },
        {},
        cordelia,
    );
    check("moving a conversation puts it under the other section", true);
    check("opening the menu did not navigate", page.url() === url_before);
    await sidebar_clip(page, "ps-05-moved");

    // Create a section from the menu.
    await page.hover(row_selector);
    await page.click(`${row_selector} .dm-sidebar-menu-icon`);
    await page.waitForSelector(".dm-popover-new-section", {visible: true});
    await page.click(".dm-popover-new-section");
    await common.wait_for_micromodal_to_open(page);
    await common.screenshot(page, "ps-06-new-section-modal");
    // A name that is already taken is rejected in the dialog.
    await page.type("#personal_section_name", "project");
    await page.click("#personal_section_name_modal .dialog_submit_button");
    await page.waitForSelector("#dialog_error", {visible: true});
    await common.screenshot(page, "ps-07-duplicate-name-error");
    await common.clear_and_type(page, "#personal_section_name", "Friends");
    await page.click("#personal_section_name_modal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForFunction(
        () =>
            document.querySelectorAll("#direct-messages-list .dm-list-personal-section-header")
                .length === 4,
    );
    check("new section is created", (await section_names(page)).includes("Friends"));

    // Remove the conversation from its section.
    await page.hover(row_selector);
    await page.click(`${row_selector} .dm-sidebar-menu-icon`);
    await page.waitForSelector(".dm-popover-remove-from-section", {visible: true});
    await sidebar_clip(page, "ps-08-menu-in-section");
    await page.click(".dm-popover-remove-from-section");
    await page.waitForFunction(() =>
        [...document.querySelectorAll("#direct-messages-list .dm-list-section-header")].some(
            (element) => !element.classList.contains("dm-list-personal-section-header"),
        ),
    );
    check("removed conversation appears under the Other heading", true);
    await sidebar_clip(page, "ps-09-removed-other-heading");

    // Collapse a section with the mouse, and expand it with the keyboard.
    const project_header =
        '#direct-messages-list .dm-list-personal-section-header[data-section-name="Project"]';
    const rows_before = await page.$$eval("#direct-messages-list .dm-list-item", (r) => r.length);
    await page.click(`${project_header} .dm-list-section-name`);
    await page.waitForFunction(
        (project_header) =>
            document.querySelector(project_header)?.getAttribute("aria-expanded") === "false",
        {},
        project_header,
    );
    const rows_collapsed = await page.$$eval(
        "#direct-messages-list .dm-list-item",
        (r) => r.length,
    );
    check("collapsing hides the conversations of the section", rows_collapsed < rows_before);
    await sidebar_clip(page, "ps-10-collapsed");

    await page.reload({waitUntil: "networkidle2"});
    await page.waitForSelector(project_header, {visible: true});
    check(
        "tab unread count is shown after a reload",
        (await page.$eval(
            '#left-sidebar-tabs .ind-tab[data-tab-key="chats"] .unread_count',
            (element) => element.textContent.trim(),
        )) === "1",
    );
    check(
        "Chats tab stays selected after a reload",
        (await page.$('#left-sidebar-tabs .ind-tab.selected[data-tab-key="chats"]')) !== null,
    );
    check(
        "collapsed state survives a reload",
        (await page.$eval(project_header, (e) => e.getAttribute("aria-expanded"))) === "false",
    );

    await page.focus(project_header);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
        (project_header) =>
            document.querySelector(project_header)?.getAttribute("aria-expanded") === "true",
        {},
        project_header,
    );
    check("Enter on the header expands the section", true);

    // Arrow keys move from the header to the conversations below.
    await page.focus(project_header);
    await page.keyboard.press("ArrowDown");
    const focused_after_arrow = await page.evaluate(
        () => document.activeElement?.closest("li")?.className ?? "",
    );
    check("ArrowDown moves to a conversation row", focused_after_arrow.includes("dm-list-item"));
    await sidebar_clip(page, "ps-11-keyboard-focus");

    // Section menu: rename and delete.
    await page.hover(project_header);
    await page.waitForSelector(`${project_header} .dm-section-sidebar-menu-icon`, {
        visible: true,
    });
    await sidebar_clip(page, "ps-12-header-hover");
    await page.click(`${project_header} .dm-section-sidebar-menu-icon`);
    await page.waitForSelector(".dm-section-popover-rename", {visible: true});
    await sidebar_clip(page, "ps-13-section-menu");
    check(
        "opening the section menu does not collapse the section",
        (await page.$eval(project_header, (e) => e.getAttribute("aria-expanded"))) === "true",
    );
    await page.click(".dm-section-popover-rename");
    await common.wait_for_micromodal_to_open(page);
    await common.screenshot(page, "ps-14-rename-modal");
    await common.clear_and_type(page, "#personal_section_name", "Work");
    await page.click("#personal_section_name_modal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForFunction(() =>
        [...document.querySelectorAll("#direct-messages-list .dm-list-section-name")].some(
            (element) => element.textContent.trim() === "Work",
        ),
    );
    check("section is renamed", true);

    const notes_header =
        '#direct-messages-list .dm-list-personal-section-header[data-section-name="Notes"]';
    await page.hover(notes_header);
    await page.click(`${notes_header} .dm-section-sidebar-menu-icon`);
    await page.waitForSelector(".dm-section-popover-delete", {visible: true});
    await page.click(".dm-section-popover-delete");
    await common.wait_for_micromodal_to_open(page);
    await common.screenshot(page, "ps-15-delete-confirm");
    await page.click(".dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await page.waitForFunction(
        (notes_header) => document.querySelector(notes_header) === null,
        {},
        notes_header,
    );
    check("section is deleted", true);
    await sidebar_clip(page, "ps-16-after-delete");

    // Search finds conversations in sections.
    await page.click(".left-sidebar-search-input");
    await page.type(".left-sidebar-search-input", "hamlet", {delay: 50});
    await page.waitForFunction(
        () => document.querySelectorAll("#direct-messages-list .dm-list-item").length === 1,
    );
    console.log("sections while searching:", JSON.stringify(await section_names(page)));
    await sidebar_clip(page, "ps-17-search");
    check(
        "search highlights the found conversation, not its section header",
        await page.evaluate(
            () =>
                document
                    .querySelector("#left-sidebar .highlighted_row")
                    ?.classList.contains("dm-list-item") === true,
        ),
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.hash.startsWith("#narrow/dm/"));
    check("Enter in the search opens the found conversation", true);
    await sidebar_clip(page, "ps-17b-active-conversation");
    // The current conversation stays visible in a collapsed section.
    await page.click(
        '#direct-messages-list .dm-list-personal-section-header[data-section-name="Work"] .dm-list-section-name',
    );
    await page.waitForFunction(
        () =>
            document
                .querySelector(
                    '#direct-messages-list .dm-list-personal-section-header[data-section-name="Work"]',
                )
                ?.getAttribute("aria-expanded") === "false",
    );
    check(
        "collapsed section still shows the current conversation",
        (await page.$("#direct-messages-list .dm-list-item.active-sub-filter")) !== null,
    );
    await sidebar_clip(page, "ps-17c-collapsed-with-active");
    await page.click(
        '#direct-messages-list .dm-list-personal-section-header[data-section-name="Work"] .dm-list-section-name',
    );
    // Zoomed-in list of all conversations; it needs more conversations
    // than the sidebar shows.
    const user_ids = await page.evaluate(async () => {
        const response = await fetch("/json/users");
        const data = (await response.json()) as {
            members: {user_id: number; is_bot: boolean; is_active: boolean}[];
        };
        return data.members
            .filter((member) => !member.is_bot && member.is_active)
            .map((member) => member.user_id);
    });
    for (const user_id of user_ids) {
        await api_request(
            page,
            "POST",
            "/json/messages",
            `type=direct&to=${encodeURIComponent(JSON.stringify([user_id]))}&content=hello`,
        );
    }
    await page.waitForFunction(
        (count) =>
            document.querySelectorAll("#direct-messages-list .dm-list-item").length >= count,
        {},
        user_ids.length - 1,
    );
    check(
        "Chats tab shows all conversations",
        (await page.$("#show-more-direct-messages")) === null,
    );
    await sidebar_clip(page, "ps-17d-many-conversations");
    await page.click('#left-sidebar-tabs .ind-tab[data-tab-key="channels"]');
    await page.waitForSelector("#show-more-direct-messages", {visible: true});
    check(
        "Channels tab limits the conversations and shows no sections",
        (await page.$("#direct-messages-list .dm-list-section-header")) === null,
    );
    await sidebar_clip(page, "ps-17e-channels-tab");
    await page.click('#left-sidebar-tabs .ind-tab[data-tab-key="chats"]');

    // Dark theme.
    await api_patch(page, "/json/settings", "color_scheme=2");
    await page.reload({waitUntil: "networkidle2"});
    await page.waitForSelector("#direct-messages-list .dm-list-personal-section-header", {
        visible: true,
    });
    await sidebar_clip(page, "ps-18-dark");
    const work_header =
        '#direct-messages-list .dm-list-personal-section-header[data-section-name="Work"]';
    await page.hover(work_header);
    await page.click(`${work_header} .dm-section-sidebar-menu-icon`);
    await page.waitForSelector(".dm-section-popover-rename", {visible: true});
    await sidebar_clip(page, "ps-19-dark-section-menu");
    await page.keyboard.press("Escape");
    await api_patch(page, "/json/settings", "color_scheme=3");

    // Narrow window.
    await page.setViewport({width: 480, height: 800});
    await page.reload({waitUntil: "networkidle2"});
    // Two toggle buttons exist; click the one shown at this width.
    await page.evaluate(() => {
        [...document.querySelectorAll<HTMLElement>(".left-sidebar-toggle-button")]
            .find((element) => element.offsetParent !== null)
            ?.click();
    });
    await page.waitForSelector("#direct-messages-list .dm-list-personal-section-header", {
        visible: true,
    });
    await common.screenshot(page, "ps-20-narrow");
    const narrow_row = "#direct-messages-list .dm-list-item .dm-sidebar-menu-icon";
    await page.hover("#direct-messages-list .dm-list-item");
    await page.waitForSelector(narrow_row, {visible: true});
    await page.click(narrow_row);
    await page.waitForSelector(".dm-popover-new-section", {visible: true});
    await common.screenshot(page, "ps-21-narrow-menu");
    const popover_box = await page.evaluate(() => {
        const rect = document
            .querySelector(".dm-popover-new-section")!
            .closest(".tippy-box")!
            .getBoundingClientRect();
        return {left: rect.left, right: rect.right, width: window.innerWidth};
    });
    check(
        "menu fits in a narrow window",
        popover_box.left >= 0 && popover_box.right <= popover_box.width,
        JSON.stringify(popover_box),
    );
    await page.keyboard.press("Escape");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
