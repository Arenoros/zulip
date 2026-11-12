import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
// The backgrounds in INITIALS_AVATAR_COLORS, in order.
const backgrounds = ["#c9cff7", "#f5d0b5", "#bfe3d0", "#f3c4d2", "#c6e2f5", "#e6dcb0"];

async function clip(page: Page, selector: string, name: string, pad = 8): Promise<void> {
    const box = await page.evaluate(
        (selector, pad) => {
            const element = document.querySelector(selector);
            if (!element) {
                return undefined;
            }
            let rect = element.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > window.innerHeight) {
                element.scrollIntoView({block: "center"});
                rect = element.getBoundingClientRect();
            }
            const x = Math.max(0, rect.left - pad);
            const y = Math.max(0, rect.top - pad);
            // Clips are in page coordinates, and the message feed scrolls the page.
            return {
                x: x + window.scrollX,
                y: y + window.scrollY,
                width: Math.min(window.innerWidth - x, rect.width + 2 * pad),
                height: Math.min(window.innerHeight - y, rect.height + 2 * pad),
            };
        },
        selector,
        pad,
    );
    if (box === undefined) {
        console.log(`SKIP ${name}: ${selector} not found`);
        return;
    }
    await page.screenshot({
        path: `var/puppeteer/initials-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function api(page: Page, method: string, url: string, body = ""): Promise<number> {
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
                body: method === "GET" || method === "DELETE" ? null : body,
            });
            return response.status;
        },
        method,
        url,
        body,
    );
}

// The source and the top left pixel of the avatar in the navbar.
async function navbar_avatar(page: Page): Promise<{src: string; color: string}> {
    return await page.evaluate(async () => {
        const image = document.querySelector<HTMLImageElement>(".header-button-avatar-image")!;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const [r, g, b] = context.getImageData(2, 2, 1, 1).data;
        const hex = (value: number | undefined): string => value!.toString(16).padStart(2, "0");
        return {src: image.getAttribute("src")!, color: `#${hex(r)}${hex(g)}${hex(b)}`};
    });
}

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);
    const me = await page.evaluate(() => zulip_test.current_user.user_id);

    // The option in the organization settings.
    await page.goto(`${base_url}#organization/organization-settings`);
    await page.waitForSelector("#id_realm_default_avatar_source", {visible: true});
    await clip(page, "#id_realm_default_avatar_source", "settings-options");
    const options = await page.evaluate(() =>
        [
            ...document.querySelectorAll<HTMLInputElement>(
                "#id_realm_default_avatar_source input",
            ),
        ].map((input) => input.value),
    );
    check("settings offer three default pictures", options.join(",") === "J,I,G", options.join(","));

    await page.click("#id_realm_default_avatar_source input[value='I']");
    await page.evaluate(() => {
        document
            .querySelector("#id_realm_default_avatar_source")!
            .closest(".settings-subsection-parent")!
            .querySelector<HTMLElement>(".save-button")!
            .click();
    });
    await page.waitForFunction(() => zulip_test.realm.realm_default_avatar_source === "I");
    check("initials can be saved as the default picture", true);
    await clip(page, "#id_realm_default_avatar_source", "settings-saved");
    await page.goto(`${base_url}#feed`);
    await page.waitForSelector("#settings_overlay_container", {hidden: true});
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});

    // Only an uploaded picture can be reset, so upload one first.
    const upload_status = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 100;
        canvas.height = 100;
        canvas.getContext("2d")!.fillRect(0, 0, 100, 100);
        const blob = await new Promise<Blob>((resolve) => {
            canvas.toBlob((blob) => {
                resolve(blob!);
            }, "image/png");
        });
        const form = new FormData();
        form.append("file", blob, "picture.png");
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')?.value ??
            "";
        const response = await fetch("/json/users/me/avatar", {
            method: "POST",
            headers: {"X-CSRFToken": csrf_token},
            body: form,
        });
        return response.status;
    });
    check("a picture can be uploaded", upload_status === 200, String(upload_status));
    await page.waitForFunction(() => zulip_test.current_user.avatar_source === "U");
    const uploaded = await navbar_avatar(page);

    // Resetting one's own picture now draws initials.
    const status = await api(page, "DELETE", "/json/users/me/avatar");
    check("own picture can be reset", status === 200, String(status));
    await page.waitForFunction(
        (old_src) =>
            document.querySelector(".header-button-avatar-image")?.getAttribute("src") !== old_src,
        {},
        uploaded.src,
    );
    const initials = await navbar_avatar(page);
    check(
        "the reset picture has the color for the user's ID",
        initials.color === backgrounds[me % backgrounds.length],
        JSON.stringify({me, initials}),
    );
    await clip(page, "#personal-menu", "navbar-button", 12);

    await page.click("#personal-menu");
    await page.waitForSelector("#personal-menu-dropdown .avatar-image", {visible: true});
    await clip(page, "#personal-menu-dropdown .personal-menu-header", "personal-menu");
    await page.keyboard.press("Escape");

    // The picture in the message feed.
    await common.send_message(page, "stream", {
        stream_name: "Verona",
        topic: "initials",
        content: "a message from a user with initials",
    });
    await page.waitForSelector(".focused-message-list .message-avatar", {visible: true});
    await clip(page, ".focused-message-list .message_row", "feed");

    // Renaming the user changes the letters without a reload.
    const rename_status = await api(page, "PATCH", "/json/settings", "full_name=Olga Petrova");
    check("the user can be renamed", rename_status === 200, String(rename_status));
    await page.waitForFunction(
        (old_src) =>
            document.querySelector(".header-button-avatar-image")?.getAttribute("src") !== old_src,
        {},
        initials.src,
    );
    const renamed = await navbar_avatar(page);
    check(
        "the picture keeps its color after a rename",
        renamed.color === initials.color,
        JSON.stringify(renamed),
    );
    await page.waitForFunction(
        (old_src) =>
            document
                .querySelector(".focused-message-list .message-avatar .no-drag")
                ?.getAttribute("src") !== old_src,
        {},
        initials.src,
    );
    await clip(page, "#personal-menu", "navbar-button-renamed", 12);
    await clip(page, ".focused-message-list .message_row", "feed-renamed");

    // The picture at its largest, in the profile.
    await page.goto(`${base_url}#user/${me}`);
    await page.waitForSelector("#user-profile-modal #avatar", {visible: true});
    await clip(page, "#user-profile-modal #avatar", "profile", 16);

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
