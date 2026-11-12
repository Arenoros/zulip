import assert from "node:assert/strict";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

async function api(page: Page, method: string, url: string, body?: string): Promise<unknown> {
    return await page.evaluate(
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
                body: body ?? null,
            });
            return await response.json();
        },
        method,
        url,
        body,
    );
}

async function sidebar_clip(page: Page, name: string): Promise<void> {
    const box = await page.evaluate(() => {
        const rect = document.querySelector("#left-sidebar")!.getBoundingClientRect();
        return {x: rect.x, y: rect.y, width: rect.width + 500, height: Math.min(rect.height, 760)};
    });
    await page.screenshot({
        path: `var/puppeteer/${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

function section_selector(folder_id: number): string {
    return `#stream_filters .stream-list-section-container[data-section-id="${folder_id}"]`;
}

async function pill_names(page: Page, selector: string): Promise<string[]> {
    return await page.$$eval(`${selector} .pill`, (pills) =>
        pills.map((pill) => pill.textContent.trim()),
    );
}

async function visual_test(page: Page): Promise<void> {
    const hamlet_password = process.env["HAMLET_PASSWORD"];
    assert.ok(hamlet_password !== undefined, "HAMLET_PASSWORD is required");

    // The owner creates a private folder.
    await common.log_in(page);
    await page.waitForSelector("#subscribe-to-more-streams", {visible: true});
    const cordelia = (await common.get_user_id_from_name(page, common.fullname.cordelia))!;

    await page.goto("http://zulip.zulipdev.com:9981/#channels/new");
    await page.waitForSelector("#stream_creation_form .create-channel-folder-button", {
        visible: true,
    });
    await page.click("#stream_creation_form .create-channel-folder-button");
    await common.wait_for_micromodal_to_open(page);
    await page.waitForSelector("#id_new_channel_folder_can_access_group .pill", {visible: true});
    check(
        "a new folder is visible to everyone by default",
        (await pill_names(page, "#id_new_channel_folder_can_access_group")).join("|").startsWith("Everyone"),
        JSON.stringify(await pill_names(page, "#id_new_channel_folder_can_access_group")),
    );
    await common.screenshot(page, "pf-01-create-folder-modal");

    await page.type("#new_channel_folder_name", "Secret");
    await page.click("#id_new_channel_folder_can_access_group .pill .exit");
    await common.select_item_via_typeahead(
        page,
        "#id_new_channel_folder_can_access_group .input",
        "cord",
        common.fullname.cordelia,
    );
    await common.screenshot(page, "pf-02-private-folder-chosen");
    await page.click("#create_channel_folder .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);

    const folders = (await api(page, "GET", "/json/channel_folders")) as {
        channel_folders: {id: number; name: string; can_access_group: unknown}[];
    };
    const folder = folders.channel_folders.find((folder) => folder.name === "Secret")!;
    check(
        "the folder is created private",
        JSON.stringify(folder.can_access_group) ===
            JSON.stringify({direct_members: [cordelia], direct_subgroups: []}),
        JSON.stringify(folder.can_access_group),
    );
    await page.click("#stream_creation_form .create_stream_cancel");

    const created = (await api(
        page,
        "POST",
        "/json/channels/create",
        `name=plans&folder_id=${folder.id}&subscribers=${encodeURIComponent(JSON.stringify([]))}`,
    )) as {id: number};
    await api(
        page,
        "POST",
        "/json/messages",
        `type=stream&to=${created.id}&topic=road&content=${encodeURIComponent("the plan")}`,
    );

    // Hamlet, who cannot see the folder, in a second window.
    const hamlet_context = await page.browser().createBrowserContext();
    const hamlet_page = await hamlet_context.newPage();
    await common.log_in(hamlet_page, {username: "hamlet@zulip.com", password: hamlet_password});
    await hamlet_page.waitForSelector("#subscribe-to-more-streams", {visible: true});
    check(
        "the private folder is hidden from those who cannot see it",
        (await hamlet_page.$(section_selector(folder.id))) === null,
    );
    const hamlet_folders = (await api(hamlet_page, "GET", "/json/channel_folders")) as {
        channel_folders: {id: number}[];
    };
    check(
        "the API does not list the folder",
        !hamlet_folders.channel_folders.some((f) => f.id === folder.id),
    );

    // The owner lets Hamlet see the folder from the folder dialog.
    await page.bringToFront();
    await page.goto("http://zulip.zulipdev.com:9981/#inbox");
    await page.waitForSelector("#subscribe-to-more-streams", {visible: true});
    console.log("created:", JSON.stringify(created));
    console.log(
        "owner subscribes:",
        JSON.stringify(
            await api(
                page,
                "POST",
                "/json/users/me/subscriptions",
                `subscriptions=${encodeURIComponent(JSON.stringify([{name: "Secret/plans"}]))}`,
            ),
        ),
    );
    await page.waitForSelector("#subscribe-to-more-streams", {visible: true});
    await page.waitForFunction(
        (selector) => document.querySelector(selector) !== null,
        {},
        section_selector(folder.id),
    );
    const header = `${section_selector(folder.id)} .stream-list-subsection-header`;
    await page.hover(header);
    await page.click(`${header} .folder-section-sidebar-menu-icon`);
    await page.waitForSelector("#folder_popover_manage_folder", {visible: true});
    await page.click("#folder_popover_manage_folder");
    await common.wait_for_micromodal_to_open(page);
    await page.waitForSelector("#id_channel_folder_can_access_group .pill", {visible: true});
    await common.screenshot(page, "pf-03-manage-folder-modal");
    await common.select_item_via_typeahead(
        page,
        "#id_channel_folder_can_access_group .input",
        "haml",
        common.fullname.hamlet,
    );
    await page.click("#edit_channel_folder .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);

    await hamlet_page.bringToFront();
    await hamlet_page.waitForFunction(
        async (folder_id) => {
            const response = await fetch("/json/channel_folders");
            const data = (await response.json()) as {channel_folders: {id: number}[]};
            return data.channel_folders.some((folder) => folder.id === folder_id);
        },
        {},
        folder.id,
    );
    check("Hamlet can now see the folder", true);

    // Hamlet subscribes and reads the channel.
    await api(
        hamlet_page,
        "POST",
        "/json/users/me/subscriptions",
        `subscriptions=${encodeURIComponent(JSON.stringify([{name: "Secret/plans"}]))}`,
    );
    // The client learned about the folder from events, without reloading.
    await hamlet_page.waitForFunction(
        (selector) => document.querySelector(`${selector} .stream-name`) !== null,
        {},
        section_selector(folder.id),
    );
    check("the folder appears in Hamlet's sidebar", true);
    await hamlet_page.goto(`http://zulip.zulipdev.com:9981/#narrow/channel/${created.id}-plans`);
    await hamlet_page.waitForFunction(
        () =>
            [...document.querySelectorAll(".message_content")].some((element) =>
                element.textContent.includes("the plan"),
            ),
        {timeout: 10000},
    );
    check("Hamlet reads the channel", true);
    await sidebar_clip(hamlet_page, "pf-04-hamlet-in-channel");

    // Taking access away while Hamlet looks at the channel.
    const updated = (await api(
        page,
        "PATCH",
        `/json/channel_folders/${folder.id}`,
        `can_access_group=${encodeURIComponent(
            JSON.stringify({new: {direct_members: [cordelia], direct_subgroups: []}}),
        )}`,
    )) as {result: string; msg: string};
    check("access is taken away", updated.result === "success", updated.msg);
    await hamlet_page.waitForSelector(section_selector(folder.id), {hidden: true});
    check("the folder disappears for Hamlet", true);
    await hamlet_page.waitForFunction(
        () => !document.querySelector("#stream_filters .stream-name")?.textContent.includes("plans"),
    );
    await sidebar_clip(hamlet_page, "pf-05-hamlet-after-revocation");
    const hamlet_subs = (await api(hamlet_page, "GET", "/json/users/me/subscriptions")) as {
        subscriptions: {stream_id: number}[];
    };
    check(
        "Hamlet is unsubscribed",
        !hamlet_subs.subscriptions.some((sub) => sub.stream_id === created.id),
    );
    const hamlet_messages = (await api(
        hamlet_page,
        "GET",
        `/json/messages?anchor=newest&num_before=10&num_after=0&narrow=${encodeURIComponent(
            JSON.stringify([{operator: "channel", operand: created.id}]),
        )}`,
    )) as {messages: unknown[]};
    check("Hamlet cannot read the channel any more", hamlet_messages.messages.length === 0);

    const blueslip_errors = await hamlet_page.evaluate(
        () => document.querySelectorAll(".blueslip-error-container .stackframe").length,
    );
    check("no client errors for Hamlet", blueslip_errors === 0, String(blueslip_errors));

    await hamlet_page.close();
    await hamlet_context.close();

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
