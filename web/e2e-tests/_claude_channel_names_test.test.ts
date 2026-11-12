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

function section_selector(section_id: number | string): string {
    return `#stream_filters .stream-list-section-container[data-section-id="${section_id}"]`;
}

// What the user sees for the channels of a section, and their full names.
async function section_channel_names(
    page: Page,
    section_id: number | string,
): Promise<{shown: string[]; full: string[]}> {
    return await page.$$eval(`${section_selector(section_id)} .stream-name`, (elements) => ({
        shown: elements.map((element) => (element as HTMLElement).innerText.trim()),
        full: elements.map((element) => element.textContent.trim()),
    }));
}

async function wait_for_channel_in_section(
    page: Page,
    section_id: number | string,
    full_name: string,
): Promise<void> {
    await page.waitForFunction(
        (selector, full_name) =>
            [...document.querySelectorAll(`${selector} .stream-name`)].some(
                (element) => element.textContent.trim() === full_name,
            ),
        {},
        section_selector(section_id),
        full_name,
    );
}

async function channel_name_note(page: Page, container: string): Promise<string> {
    return await page.$eval(`${container} .channel-name-in-folder-note`, (e) =>
        e.textContent.trim(),
    );
}

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);
    await page.waitForSelector("#subscribe-to-more-streams", {visible: true});

    const design = (await api(
        page,
        "POST",
        "/json/channel_folders/create",
        "name=Design&description=",
    )) as {channel_folder_id: number};
    const support = (await api(
        page,
        "POST",
        "/json/channel_folders/create",
        "name=Support&description=",
    )) as {channel_folder_id: number};
    await page.waitForSelector(section_selector(design.channel_folder_id), {visible: true});

    // Create a channel from the header of a folder.
    const header = `${section_selector(design.channel_folder_id)} .stream-list-subsection-header`;
    await page.hover(header);
    await page.click(`${header} .add-stream-icon-container`);
    await page.waitForSelector("#create_stream_name", {visible: true});
    check(
        "no note about the name before one is typed",
        (await channel_name_note(page, "#stream_creation_form")) === "",
    );
    await page.type("#create_stream_name", "general");
    check(
        "the form shows the name the channel gets from its folder",
        (await channel_name_note(page, "#stream_creation_form")) ===
            "The name of the channel will be Design/general.",
        await channel_name_note(page, "#stream_creation_form"),
    );
    await common.screenshot(page, "cn-01-create-in-folder");
    await page.click("#stream_creation_go_to_subscribers");
    await page.waitForSelector("#stream_creation_form .finalize_create_stream", {visible: true});
    await page.click("#stream_creation_form .finalize_create_stream");
    await wait_for_channel_in_section(page, design.channel_folder_id, "Design/general");
    check("the channel is created with the name of its folder", true);

    // The same name in another folder, and in no folder.
    for (const [name, folder_id] of [
        ["general", support.channel_folder_id],
        ["general", undefined],
    ] as const) {
        const result = (await api(
            page,
            "POST",
            "/json/channels/create",
            `name=${name}&subscribers=${encodeURIComponent(JSON.stringify([]))}` +
                (folder_id === undefined ? "" : `&folder_id=${folder_id}`),
        )) as {result: string; msg: string};
        check(`another channel named ${name} is created`, result.result === "success", result.msg);
    }
    const streams = (await api(page, "GET", "/json/streams")) as {
        streams: {name: string; stream_id: number}[];
    };
    await api(
        page,
        "POST",
        "/json/users/me/subscriptions",
        `subscriptions=${encodeURIComponent(
            JSON.stringify([{name: "Support/general"}, {name: "general"}]),
        )}`,
    );
    await wait_for_channel_in_section(page, support.channel_folder_id, "Support/general");
    await page.goto("http://zulip.zulipdev.com:9981/#inbox");
    await page.waitForSelector(section_selector(design.channel_folder_id), {visible: true});
    await wait_for_channel_in_section(page, design.channel_folder_id, "Design/general");

    const design_names = await section_channel_names(page, design.channel_folder_id);
    const support_names = await section_channel_names(page, support.channel_folder_id);
    check(
        "the section of a folder shows short names",
        JSON.stringify(design_names.shown) === JSON.stringify(["general"]) &&
            JSON.stringify(support_names.shown) === JSON.stringify(["general"]),
        JSON.stringify([design_names, support_names]),
    );
    const other_names = await section_channel_names(page, "normal-streams");
    check(
        "the channel in no folder has its plain name",
        other_names.shown.includes("general"),
        JSON.stringify(other_names.shown),
    );
    await sidebar_clip(page, "cn-02-sidebar-short-names");

    // A pinned channel is outside the section of its folder, so it
    // is shown with its full name.
    const design_general_id = streams.streams.find(
        (stream) => stream.name === "Design/general",
    )!.stream_id;
    await api(
        page,
        "POST",
        "/json/users/me/subscriptions/properties",
        `subscription_data=${encodeURIComponent(
            JSON.stringify([{stream_id: design_general_id, property: "pin_to_top", value: true}]),
        )}`,
    );
    await wait_for_channel_in_section(page, "pinned-streams", "Design/general");
    const pinned_names = await section_channel_names(page, "pinned-streams");
    check(
        "a pinned channel is shown with its full name",
        pinned_names.shown.includes("Design/general"),
        JSON.stringify(pinned_names.shown),
    );
    await sidebar_clip(page, "cn-03-pinned-full-name");
    await api(
        page,
        "POST",
        "/json/users/me/subscriptions/properties",
        `subscription_data=${encodeURIComponent(
            JSON.stringify([{stream_id: design_general_id, property: "pin_to_top", value: false}]),
        )}`,
    );
    await wait_for_channel_in_section(page, design.channel_folder_id, "Design/general");

    // The form to create a channel knows about names taken in a folder.
    await page.goto(
        `http://zulip.zulipdev.com:9981/#channels/folders/${support.channel_folder_id}/new`,
    );
    await page.waitForSelector("#create_stream_name", {visible: true});
    await page.type("#create_stream_name", "general");
    await page.waitForSelector("#stream_name_error", {visible: true});
    check("a name taken in the folder is reported", true);
    await common.screenshot(page, "cn-04-name-taken-in-folder");
    await page.click("#create_stream_name", {count: 3});
    await page.keyboard.press("Backspace");
    await page.type("#create_stream_name", "billing");
    await page.waitForSelector("#stream_name_error", {hidden: true});
    check("a name taken only in another place is accepted", true);
    await page.click("#stream_creation_form .create_stream_cancel");

    // Renaming a channel in a folder is about its short name.
    await page.goto(
        `http://zulip.zulipdev.com:9981/#channels/${design_general_id}/Design.2Fgeneral/general`,
    );
    await page.waitForSelector("#open_stream_info_modal", {visible: true});
    await page.click("#open_stream_info_modal");
    await common.wait_for_micromodal_to_open(page);
    check(
        "the dialog to rename a channel has its short name",
        (await page.$eval("#change_stream_name", (e) => (e as HTMLInputElement).value)) ===
            "general",
    );
    await common.screenshot(page, "cn-05-rename-dialog");
    await page.click("#change_stream_name", {count: 3});
    await page.keyboard.press("Backspace");
    await page.type("#change_stream_name", "sketches");
    await page.click("#change_stream_info_modal .dialog_submit_button");
    await common.wait_for_micromodal_to_close(page);
    await wait_for_channel_in_section(page, design.channel_folder_id, "Design/sketches");
    check("the renamed channel keeps the name of its folder", true);

    // Moving the channel shows the name it will get.
    await page.waitForSelector("#folder_id_widget", {visible: true});
    await page.click("#folder_id_widget");
    await page.waitForSelector(".folder_id-dropdown-list-container .list-item", {visible: true});
    await page.click(
        `.folder_id-dropdown-list-container .list-item[data-unique-id="${support.channel_folder_id}"]`,
    );
    await page.waitForFunction(
        () =>
            document
                .querySelector("#stream_settings .channel-name-in-folder-note")
                ?.textContent.trim() !== "",
    );
    check(
        "choosing a folder shows the new name of the channel",
        (await channel_name_note(page, "#stream_settings")) ===
            "The name of the channel will be Support/sketches.",
        await channel_name_note(page, "#stream_settings"),
    );
    await common.screenshot(page, "cn-06-move-note");

    // Discarding the change removes the note.
    await page.click("#stream_settings .stream-settings-subsection .discard-button");
    await page.waitForFunction(
        () =>
            document
                .querySelector("#stream_settings .channel-name-in-folder-note")
                ?.textContent.trim() === "",
    );
    check("discarding the change removes the note", true);

    await page.click("#folder_id_widget");
    await page.waitForSelector(".folder_id-dropdown-list-container .list-item", {visible: true});
    await page.click(
        `.folder_id-dropdown-list-container .list-item[data-unique-id="${support.channel_folder_id}"]`,
    );
    await page.waitForSelector("#stream_settings .stream-settings-subsection .save-button", {
        visible: true,
    });
    await page.click("#stream_settings .stream-settings-subsection .save-button");
    await wait_for_channel_in_section(page, support.channel_folder_id, "Support/sketches");
    check("the moved channel is named after its new folder", true);
    await page.waitForFunction(
        () =>
            document
                .querySelector("#stream_settings .channel-name-in-folder-note")
                ?.textContent.trim() === "",
    );
    check("the note is gone once the channel is moved", true);
    await common.screenshot(page, "cn-07-moved");

    // Renaming a folder renames its channels.
    await api(page, "PATCH", `/json/channel_folders/${support.channel_folder_id}`, "name=Help");
    await wait_for_channel_in_section(page, support.channel_folder_id, "Help/sketches");
    await wait_for_channel_in_section(page, support.channel_folder_id, "Help/general");
    await page.goto("http://zulip.zulipdev.com:9981/#inbox");
    await page.waitForSelector(section_selector(support.channel_folder_id), {visible: true});
    await wait_for_channel_in_section(page, support.channel_folder_id, "Help/sketches");
    const help_names = await section_channel_names(page, support.channel_folder_id);
    check(
        "channels of a renamed folder are renamed and shown by short name",
        JSON.stringify(help_names.shown.toSorted()) === JSON.stringify(["general", "sketches"]) &&
            (await page.$eval(
                `${section_selector(support.channel_folder_id)} .left-sidebar-title`,
                (e) => e.textContent.trim(),
            )) === "HELP",
        JSON.stringify(help_names),
    );
    await sidebar_clip(page, "cn-08-folder-renamed");

    // Moving to a folder that has a channel of that name is refused.
    const plain_general_id = streams.streams.find((stream) => stream.name === "general")!.stream_id;
    const refused = (await api(
        page,
        "PATCH",
        `/json/streams/${plain_general_id}`,
        `folder_id=${support.channel_folder_id}`,
    )) as {result: string; msg: string};
    check("moving onto a taken name is refused", refused.result === "error", refused.msg);

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    assert.equal(failures.length, 0);
}

await common.run_test(visual_test);
