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
        return {x: rect.x, y: rect.y, width: rect.width + 300, height: Math.min(rect.height, 760)};
    });
    // Capturing beyond the viewport fires resize events, which close popovers.
    await page.screenshot({
        path: `var/puppeteer/${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

type Folder = {
    id: number;
    name: string;
    can_administer_group: number | {direct_members: number[]; direct_subgroups: number[]};
};

async function get_folder(page: Page, name: string): Promise<Folder> {
    const data = (await api(page, "GET", "/json/channel_folders")) as {channel_folders: Folder[]};
    const folder = data.channel_folders.find((folder) => folder.name === name);
    assert.ok(folder !== undefined);
    return folder;
}

function section_selector(folder_id: number): string {
    return `#stream_filters .stream-list-section-container[data-section-id="${folder_id}"]`;
}

async function open_folder_menu(page: Page, folder_id: number): Promise<void> {
    const header = `${section_selector(folder_id)} .stream-list-subsection-header`;
    await page.hover(header);
    await page.waitForSelector(`${header} .folder-section-sidebar-menu-icon`, {visible: true});
    await page.click(`${header} .folder-section-sidebar-menu-icon`);
    await page.waitForSelector("#folder_popover_view_channels", {visible: true});
}

async function visual_test(page: Page): Promise<void> {
    const hamlet_password = process.env["HAMLET_PASSWORD"];
    assert.ok(hamlet_password !== undefined, "HAMLET_PASSWORD is required");

    // An organization owner sets things up in a separate session.
    const owner_context = await page.browser().createBrowserContext();
    const owner_page = await owner_context.newPage();
    await common.log_in(owner_page);

    await common.log_in(page, {username: "hamlet@zulip.com", password: hamlet_password});
    await page.waitForSelector("#subscribe-to-more-streams", {visible: true});
    const hamlet = (await common.get_user_id_from_name(page, common.fullname.hamlet))!;
    const cordelia = (await common.get_user_id_from_name(page, common.fullname.cordelia))!;
    await sidebar_clip(page, "cf-01-member-before");
    console.log(
        "bottom link:",
        await page.$eval("#subscribe-to-more-streams", (e) => e.textContent.trim()),
    );

    // The link to create a folder takes the place of the one to create
    // a channel, which is only shown without more channels to browse.
    const streams = (await api(page, "GET", "/json/streams")) as {streams: {name: string}[]};
    await api(
        page,
        "POST",
        "/json/users/me/subscriptions",
        `subscriptions=${encodeURIComponent(
            JSON.stringify(streams.streams.map((stream) => ({name: stream.name}))),
        )}`,
    );
    await page.waitForSelector("#subscribe-to-more-streams .create-channel-folder-link", {
        visible: true,
    });
    check(
        "a member sees the link to create a folder",
        (await page.$eval("#subscribe-to-more-streams", (e) => e.textContent.trim())) ===
            "CREATE A FOLDER",
    );
    await sidebar_clip(page, "cf-02-create-folder-link");

    await page.click("#subscribe-to-more-streams .create-channel-folder-link");
    await common.wait_for_micromodal_to_open(page);
    await common.screenshot(page, "cf-03-create-folder-modal");
    await page.type("#new_channel_folder_name", "Design");
    await page.click("#create_channel_folder .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    const design = await get_folder(page, "Design");
    check(
        "the creator administers the new folder",
        JSON.stringify(design.can_administer_group) ===
            JSON.stringify({direct_members: [hamlet], direct_subgroups: []}),
        JSON.stringify(design.can_administer_group),
    );

    // The folder is shown to its creator before it has channels.
    await page.waitForSelector(section_selector(design.id), {visible: true});
    check(
        "the new folder is shown without channels",
        (await page.$eval(`${section_selector(design.id)} .left-sidebar-title`, (e) =>
            e.textContent.trim(),
        )) === "DESIGN",
    );
    await sidebar_clip(page, "cf-04-empty-folder");

    // Its menu lets the creator manage it.
    await open_folder_menu(page, design.id);
    check(
        "the creator can manage the folder",
        (await page.$("#folder_popover_manage_folder")) !== null,
    );
    await sidebar_clip(page, "cf-05-folder-menu");
    await page.click("#folder_popover_manage_folder");
    await common.wait_for_micromodal_to_open(page);
    await page.waitForSelector("#id_channel_folder_can_administer_group .pill", {visible: true});
    await common.screenshot(page, "cf-06-manage-folder-modal");
    check(
        "the administrators of the folder are listed",
        (await page.$$eval("#id_channel_folder_can_administer_group .pill", (pills) =>
            pills.map((pill) => pill.textContent.trim()).join("|"),
        )) === common.fullname.hamlet,
    );
    check(
        "nothing to save before a change",
        await page.$eval("#edit_channel_folder .dialog_submit_button", (e) =>
            (e as HTMLButtonElement).disabled,
        ),
    );

    // Appoint another administrator.
    await common.select_item_via_typeahead(
        page,
        "#id_channel_folder_can_administer_group .input",
        "cord",
        common.fullname.cordelia,
    );
    await page.waitForFunction(
        () =>
            document.querySelectorAll("#id_channel_folder_can_administer_group .pill").length ===
            2,
    );
    await common.screenshot(page, "cf-07-administrator-added");
    await page.click("#edit_channel_folder .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    const design_after = await get_folder(page, "Design");
    check(
        "the appointed administrator is saved",
        JSON.stringify(design_after.can_administer_group) ===
            JSON.stringify({
                direct_members: [cordelia, hamlet].toSorted((a, b) => a - b),
                direct_subgroups: [],
            }),
        JSON.stringify(design_after.can_administer_group),
    );

    // The plus in the header of the folder creates a channel in it.
    const header = `${section_selector(design.id)} .stream-list-subsection-header`;
    await page.hover(header);
    await page.click(`${header} .add-stream-icon-container`);
    await page.waitForSelector("#stream_creation_form", {visible: true});
    await page.waitForSelector("#create_stream_name", {visible: true});
    check(
        "the folder is chosen for the new channel",
        (await page.$eval("#new_channel_folder_id_widget", (e) => e.textContent.trim())) ===
            "Design",
    );
    await common.screenshot(page, "cf-08-create-channel-in-folder");
    await page.type("#create_stream_name", "sketches");
    await page.click("#stream_creation_go_to_subscribers");
    await page.waitForSelector("#stream_creation_form .finalize_create_stream", {visible: true});
    await page.click("#stream_creation_form .finalize_create_stream");
    await page.waitForFunction(
        (selector) =>
            [...document.querySelectorAll(`${selector} .stream-name`)].some(
                (element) => element.textContent.trim() === "Design/sketches",
            ),
        {},
        section_selector(design.id),
    );
    check("the new channel is in the folder", true);
    await page.goto("http://zulip.zulipdev.com:9981/#inbox");
    await page.waitForSelector(section_selector(design.id), {visible: true});
    await sidebar_clip(page, "cf-09-channel-in-folder");

    // A folder of someone else, with a channel of the member in it.
    const research = (await api(
        owner_page,
        "POST",
        "/json/channel_folders/create",
        "name=Research&description=",
    )) as {channel_folder_id: number};
    const verona_id = await common.get_stream_id(owner_page, "Verona");
    await api(
        owner_page,
        "PATCH",
        `/json/streams/${verona_id}`,
        `folder_id=${research.channel_folder_id}`,
    );
    await page.waitForSelector(section_selector(research.channel_folder_id), {visible: true});
    await open_folder_menu(page, research.channel_folder_id);
    check(
        "a member cannot manage the folder of someone else",
        (await page.$("#folder_popover_manage_folder")) === null,
    );
    await sidebar_clip(page, "cf-10-other-folder-menu");
    await page.keyboard.press("Escape");

    // The settings of the channel the member administers offer the
    // folders they can move it to.
    const sketches_id = await common.get_stream_id(page, "Design/sketches");
    await page.goto(`http://zulip.zulipdev.com:9981/#channels/${sketches_id}/Design.2Fsketches/general`);
    await page.waitForSelector("#folder_id_widget", {visible: true});
    await page.click("#folder_id_widget");
    await page.waitForSelector(".folder_id-dropdown-list-container .list-item", {visible: true});
    const options = await page.$$eval(".folder_id-dropdown-list-container .list-item", (items) =>
        items.map((item) => item.textContent.replaceAll(/\s+/g, " ").trim()),
    );
    console.log("folder options:", JSON.stringify(options));
    check(
        "only the folders the member administers are offered",
        options.includes("Design") && options.includes("None") && !options.includes("Research"),
    );
    await common.screenshot(page, "cf-11-folder-options");
    await page.keyboard.press("Escape");

    // The server refuses what the options leave out.
    const refused = (await api(
        page,
        "PATCH",
        `/json/streams/${sketches_id}`,
        `folder_id=${research.channel_folder_id}`,
    )) as {result: string; msg: string};
    check("moving to a folder of someone else is refused", refused.result === "error", refused.msg);

    await owner_page.close();
    await owner_context.close();

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
