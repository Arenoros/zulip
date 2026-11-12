import process from "node:process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

// "before" or "after", so that both sets of screenshots can be kept.
const prefix = process.env["SHOT_PREFIX"] ?? "after";
const base_url = "http://zulip.zulipdev.com:9981/";
const short_wait = {timeout: 8000};

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
    if (box === undefined || box.width <= 0 || box.height <= 0) {
        console.log(`SKIP ${name}: ${selector} not found`);
        return;
    }
    console.log(`BOX ${name} ${JSON.stringify(box)}`);
    // Capturing beyond the viewport fires resize events, which close popovers.
    await page.screenshot({
        path: `var/puppeteer/avatars-${prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
    console.log(`SHOT ${name}`);
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (error) {
        console.log(`SKIP ${name}: ${String(error).split("\n")[0]}`);
    }
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

async function go(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
}

async function close_popovers(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-tippy-root] .popover-menu", {hidden: true, ...short_wait});
}

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);
    const polonius = await common.get_user_id_from_name(page, "Polonius");
    const hamlet = await common.get_user_id_from_name(page, common.fullname.hamlet);
    const cordelia = await common.get_user_id_from_name(page, common.fullname.cordelia);
    const me = await page.evaluate(() => zulip_test.current_user.user_id);
    console.log(`IDS ${JSON.stringify({polonius, hamlet, cordelia, me})}`);

    // Messages from a guest and from a user who is deactivated below.
    await page.click("#left-sidebar-navigation-list .top_left_all_messages");
    const message_list_id = await common.get_current_msg_list_id(page, true);
    await page.waitForSelector(
        `.message-list[data-message-list-id='${message_list_id}'] .message_row`,
        {visible: true},
    );

    await step("feed", async () => {
        await clip(page, ".focused-message-list", "feed", 0);
    });

    await step("feed-guest", async () => {
        const found = await page.evaluate(() => {
            const picture = document.querySelector(".focused-message-list .guest-avatar");
            picture?.closest(".message_row")?.scrollIntoView({block: "center"});
            picture?.closest(".message_row")?.classList.add("claude-guest-row");
            return picture !== null;
        });
        if (found) {
            await clip(page, ".claude-guest-row", "feed-guest");
        } else {
            console.log("SKIP feed-guest: no guest message in the feed");
        }
    });

    await step("user-card", async () => {
        await page.click(".focused-message-list .message-avatar");
        await page.waitForSelector(".popover-menu-user-avatar", {visible: true, ...short_wait});
        await clip(page, "[data-tippy-root] .tippy-box", "user-card");
        await close_popovers(page);
    });

    await step("personal-menu", async () => {
        await clip(page, "#personal-menu", "navbar-button", 12);
        await page.click("#personal-menu");
        await page.waitForSelector("#personal-menu-dropdown .avatar-image", {
            visible: true,
            ...short_wait,
        });
        await clip(page, "#personal-menu-dropdown .personal-menu-header", "personal-menu");
        await close_popovers(page);
    });

    await step("typeahead", async () => {
        await page.keyboard.press("KeyC");
        await page.waitForSelector("#compose-textarea", {visible: true, ...short_wait});
        await page.type("#compose-textarea", "@ia");
        await page.waitForSelector(".typeahead-image-avatar", {visible: true, ...short_wait});
        await page.evaluate(() => {
            const images = [...document.querySelectorAll<HTMLElement>(".typeahead-image-avatar")];
            images
                .find((image) => image.offsetParent !== null)!
                .closest("ul")!
                .classList.add("claude-typeahead-list");
        });
        await clip(page, ".claude-typeahead-list", "typeahead");
        await page.keyboard.press("Escape");
        await common.clear_and_type(page, "#compose-textarea", "");
        await page.keyboard.press("Escape");
    });

    await step("recipient-pill", async () => {
        await go(page, `#narrow/dm/${cordelia}`);
        await page.waitForSelector("#message_view_header .navbar_title", {
            visible: true,
            ...short_wait,
        });
        await page.keyboard.press("KeyC");
        await page.waitForSelector("#compose-direct-recipient .pill", {
            visible: true,
            ...short_wait,
        });
        await clip(page, "#compose-direct-recipient", "recipient-pill", 12);
        await page.focus("#private_message_recipient");
        await page.keyboard.press("ArrowLeft");
        await clip(page, "#compose-direct-recipient", "recipient-pill-focused", 12);
        await page.keyboard.press("Escape");
    });

    await step("recent", async () => {
        await go(page, "#recent");
        await page.waitForSelector(".recent_view_participant_avatar", {
            visible: true,
            ...short_wait,
        });
        await clip(page, "#recent-view-content-table", "recent", 0);
    });

    await step("profile-modal", async () => {
        await go(page, `#user/${me}`);
        await page.waitForSelector("#user-profile-modal #avatar", {visible: true, ...short_wait});
        await clip(page, "#user-profile-modal .modal__header", "profile-modal-header");
        await clip(page, "#user-profile-modal #avatar", "profile-modal", 16);
        await page.keyboard.press("Escape");
        await page.waitForSelector("#user-profile-modal", {hidden: true, ...short_wait});
    });

    await step("settings-profile", async () => {
        await go(page, "#settings/profile");
        await page.waitForSelector("#user-avatar-upload-widget", {visible: true, ...short_wait});
        await clip(page, ".user-avatar-section", "settings-profile", 16);
        await page.hover("#user-avatar-upload-widget");
        await clip(page, ".user-avatar-section", "settings-profile-hover", 16);
        // The delete button is shown only for an uploaded picture; reveal it
        // here to see where it sits.
        await page.evaluate(() => {
            const button = document.querySelector<HTMLElement>(
                "#user-avatar-upload-widget .image-delete-button",
            )!;
            button.classList.remove("hide");
            button.style.opacity = "1";
            button.style.display = "block";
        });
        await clip(page, ".user-avatar-section", "settings-profile-delete", 16);
    });

    await step("settings-preferences", async () => {
        await go(page, "#settings/preferences");
        await page.waitForSelector(".information-settings .user-profile-picture", short_wait);
        await page.evaluate(() => {
            document
                .querySelector(".information-settings .profile-with-avatar")!
                .scrollIntoView({block: "center"});
        });
        await clip(page, ".information-settings .profile-with-avatar", "settings-user-list", 12);
    });

    await step("settings-default-avatar", async () => {
        await go(page, "#organization/organization-settings");
        await page.waitForSelector("#id_realm_default_avatar_source", {
            visible: true,
            ...short_wait,
        });
        await page.evaluate(() => {
            document
                .querySelector("#id_realm_default_avatar_source")!
                .scrollIntoView({block: "center"});
        });
        await clip(page, "#id_realm_default_avatar_source", "settings-default-avatar");
        await page.keyboard.press("Escape");
    });

    // The right sidebar shows avatars only in this user list style.
    await step("right-sidebar", async () => {
        await api(page, "PATCH", "/json/settings", "user_list_style=3");
        await go(page, "#feed");
        await page.waitForSelector("#user-list .user-profile-picture", {
            visible: true,
            ...short_wait,
        });
        await clip(page, "#user-list", "right-sidebar", 0);
    });

    await step("deactivated", async () => {
        const status = await api(page, "DELETE", `/json/users/${hamlet}`);
        console.log(`DEACTIVATE ${status}`);
        await go(page, `#narrow/dm/${hamlet}`);
        await page.waitForSelector("#message_view_header .navbar_title", {
            visible: true,
            ...short_wait,
        });
        await go(page, `#narrow/sender/${hamlet}`);
        await page.waitForSelector(".focused-message-list .inline_profile_picture.deactivated", {
            visible: true,
            timeout: 20000,
        });
        await page.evaluate(() => {
            document
                .querySelector(".focused-message-list .inline_profile_picture.deactivated")!
                .closest(".message_row")!
                .classList.add("claude-deactivated-row");
        });
        await clip(page, ".claude-deactivated-row", "feed-deactivated");
        await page.click(".claude-deactivated-row .message-avatar");
        await page.waitForSelector(".popover-menu-user-avatar", {visible: true, ...short_wait});
        await clip(page, "[data-tippy-root] .tippy-box", "user-card-deactivated");
        await close_popovers(page);
    });

    await step("guest-in-feed", async () => {
        await go(page, `#narrow/sender/${polonius}`);
        await page.waitForSelector(".focused-message-list .guest-avatar", {
            visible: true,
            ...short_wait,
        });
        await page.evaluate(() => {
            document
                .querySelector(".focused-message-list .guest-avatar")!
                .closest(".message_row")!
                .classList.add("claude-guest-sender-row");
        });
        await clip(page, ".claude-guest-sender-row", "feed-guest-sender");
        await page.click(".claude-guest-sender-row .message-avatar");
        await page.waitForSelector(".popover-menu-user-avatar", {visible: true, ...short_wait});
        await clip(page, "[data-tippy-root] .tippy-box", "user-card-guest");
        await page.click("[data-tippy-root] .view_full_user_profile");
        // An earlier, closed profile modal can still be in the document.
        await page.waitForFunction(
            () =>
                [...document.querySelectorAll<HTMLElement>("#user-profile-modal .guest-avatar")].some(
                    (element) => element.offsetParent !== null,
                ),
            {timeout: 20000},
        );
        await page.evaluate(() => {
            [...document.querySelectorAll<HTMLElement>("#user-profile-modal .guest-avatar")]
                .find((element) => element.offsetParent !== null)!
                .classList.add("claude-guest-profile-avatar");
        });
        await clip(page, ".claude-guest-profile-avatar", "profile-modal-guest", 16);
        await page.keyboard.press("Escape");
    });
}

await common.run_test(visual_test);
