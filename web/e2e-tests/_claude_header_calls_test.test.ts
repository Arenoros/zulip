import {execSync} from "node:child_process";

import type {Browser, HTTPRequest, Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "header-calls";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json

from django.conf import settings

from zerver.actions.message_send import internal_send_private_message
from zerver.actions.users import do_deactivate_user
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_system_bot, get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)
`;

// Prospero is deactivated, and there are conversations with a bot and
// with a group.
const seed_script =
    python_prelude +
    String.raw`
desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
hamlet = user("hamlet@zulip.com")
prospero = user("prospero@zulip.com")
welcome_bot = get_system_bot(settings.WELCOME_BOT, realm.id)

do_deactivate_user(prospero, acting_user=None)
internal_send_private_message(othello, desdemona, "Hello from Othello")
internal_send_private_message(welcome_bot, desdemona, "Hello from the bot")

print(
    "SEEDED "
    + json.dumps(
        {
            "desdemona": desdemona.id,
            "othello": othello.id,
            "hamlet": hamlet.id,
            "prospero": prospero.id,
            "welcome_bot": welcome_bot.id,
            "denmark": get_stream("Denmark", realm).id,
        }
    )
)
`;

type Seeded = {
    desdemona: number;
    othello: number;
    hamlet: number;
    prospero: number;
    welcome_bot: number;
    denmark: number;
};

async function patch(page: Page, url: string, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(
        async (url, body) => {
            const csrf_token =
                document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                    ?.value ?? "";
            const response = await fetch(url, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": csrf_token,
                },
                body,
            });
            return response.status;
        },
        url,
        body,
    );
    if (status !== 200) {
        throw new Error(`PATCH ${url} ${body} failed with ${status}`);
    }
}

async function open_view(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.waitForSelector("#message_view_header .message-header-navbar-title", {
        visible: true,
    });
    await page.mouse.move(1, 1);
}

async function shot_header(page: Page, name: string): Promise<void> {
    // Let avatars and fonts settle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.evaluate(() => {
        const rect = document.querySelector("#navbar-middle")!.getBoundingClientRect();
        return {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

type CallButtonFacts = {
    labels: string[];
    header: {top: number; bottom: number};
    buttons: {left: number; right: number; top: number; bottom: number}[];
    title_right: number;
    search_left: number;
    title_truncated: boolean;
};

async function call_button_facts(page: Page): Promise<CallButtonFacts> {
    return await page.evaluate(() => {
        const header = document.querySelector("#message_view_header")!;
        const title = header.querySelector(".message-header-navbar-title")!;
        const buttons = [
            ...header.querySelectorAll(".message-view-header-call-buttons .icon-button"),
        ];
        const header_rect = header.getBoundingClientRect();
        return {
            labels: buttons.map((button) => button.getAttribute("aria-label") ?? ""),
            header: {top: header_rect.top, bottom: header_rect.bottom},
            buttons: buttons.map((button) => {
                const rect = button.getBoundingClientRect();
                return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
            }),
            title_right: title.getBoundingClientRect().right,
            search_left: document.querySelector("#searchbox .search_icon")!.getBoundingClientRect()
                .left,
            title_truncated: title.scrollWidth > title.clientWidth,
        };
    });
}

async function has_call_buttons(page: Page): Promise<boolean> {
    return (await page.$("#message_view_header .message-view-header-call-buttons")) !== null;
}

// Clicks a call button, and returns the address the call window opens.
async function start_call(browser: Browser, page: Page, selector: string): Promise<string> {
    const target_promise = browser.waitForTarget((target) =>
        target.url().includes("/calls/livekit/join"),
    );
    await page.click(selector);
    const target = await target_promise;
    const url = target.url();
    const call_page = await target.page();
    await call_page?.close();
    return url;
}

function dm_hash(user_ids: number[]): string {
    return `#narrow/dm/${user_ids.join(",")}-dm`;
}

async function header_calls_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;

    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await common.log_in(page);
    await page.waitForSelector("#message_view_header", {visible: true});
    await page.setViewport({width: 1280, height: 1000});
    await patch(page, "/json/realm", "video_chat_provider=10");
    await patch(
        page,
        "/json/settings",
        "color_scheme=3&web_direct_message_bubbles=true&web_font_size_px=15&web_line_height_percent=140",
    );
    await page.reload();
    const browser = page.browser();

    const views = {
        othello: dm_hash([seeded.othello]),
        hamlet: dm_hash([seeded.hamlet]),
        group: dm_hash([seeded.othello, seeded.hamlet]),
        bot: dm_hash([seeded.welcome_bot]),
        self: dm_hash([seeded.desdemona]),
        deactivated: dm_hash([seeded.prospero]),
        channel: `#narrow/channel/${seeded.denmark}-Denmark`,
        topic: `#narrow/channel/${seeded.denmark}-Denmark/topic/calls`,
    };

    // One on one, in the bubble layout.
    await open_view(page, views.othello);
    await page.waitForSelector("#message_view_header .message-view-header-call-buttons");
    let facts = await call_button_facts(page);
    const header_middle = (facts.header.top + facts.header.bottom) / 2;
    check(
        "a direct message conversation has video and voice call buttons",
        JSON.stringify(facts.labels) === JSON.stringify(["Video call", "Voice call"]),
        JSON.stringify(facts.labels),
    );
    check(
        "the call buttons sit between the name and the search, centered in the header",
        facts.buttons.every(
            (button) =>
                button.left >= facts.title_right &&
                button.right <= facts.search_left &&
                Math.abs((button.top + button.bottom) / 2 - header_middle) < 1,
        ),
        JSON.stringify(facts),
    );
    await shot_header(page, "light-othello");

    // The compose box has no call buttons.
    await page.keyboard.press("KeyR");
    await page.waitForSelector("#compose-textarea", {visible: true});
    check(
        "the compose box has no call buttons",
        (await page.$$("#compose .video_link, #compose .audio_link")).length === 0,
    );
    await page.keyboard.press("Escape");

    // A video call opens at once and rings Othello.
    const video_url = await start_call(
        browser,
        page,
        "#message_view_header .message-view-header-video-call",
    );
    check(
        "the video call button opens a call with the conversation",
        video_url.includes("/calls/livekit/join?call_id=") &&
            video_url.includes(
                `&dm=${[seeded.othello, seeded.desdemona].sort((a, b) => a - b).join(",")}`,
            ) &&
            !video_url.includes("voice_only"),
        video_url,
    );
    await page.waitForSelector("#popup_banners_wrapper .outgoing-call-banner", {visible: true});
    // Let the banner finish sliding in before clicking it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const calling = await page.$eval(
        "#popup_banners_wrapper .outgoing-call-banner .banner-label",
        (label) => label.textContent?.trim(),
    );
    check(
        "the call rings the other person",
        calling === "Calling Othello, the Moor of Venice…",
        calling,
    );
    await page.click("#popup_banners_wrapper .outgoing-call-cancel");
    await page.waitForFunction(
        () => document.querySelector("#popup_banners_wrapper .outgoing-call-banner") === null,
        {polling: 100},
    );
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".message_content a")].some((link) =>
                link.textContent?.includes("Join video call."),
            ),
        {polling: 100},
    );
    check("the call is announced in the conversation", true);

    const voice_url = await start_call(
        browser,
        page,
        "#message_view_header .message-view-header-voice-call",
    );
    check(
        "the voice call button opens a voice call",
        voice_url.endsWith("&voice_only=true"),
        voice_url,
    );
    await page.waitForSelector("#popup_banners_wrapper .outgoing-call-banner", {visible: true});
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.click("#popup_banners_wrapper .outgoing-call-cancel");
    await page.waitForFunction(
        () => document.querySelector("#popup_banners_wrapper .outgoing-call-banner") === null,
        {polling: 100},
    );

    // A group gets the buttons too.
    await open_view(page, views.group);
    check("a group conversation has call buttons", await has_call_buttons(page));
    await shot_header(page, "light-group");

    // No one to call.
    for (const name of ["bot", "self", "deactivated", "channel", "topic"] as const) {
        await open_view(page, views[name]);
        check(`no call buttons: ${name}`, !(await has_call_buttons(page)));
    }

    // The classic layout gets the buttons too.
    await patch(page, "/json/settings", "web_direct_message_bubbles=false");
    await open_view(page, views.othello);
    await page.waitForSelector("#message_view_header .message-view-header-call-buttons");
    facts = await call_button_facts(page);
    check(
        "the classic header has the call buttons at its end",
        facts.buttons.length === 2 &&
            facts.buttons.every(
                (button) => button.left >= facts.title_right && button.right <= facts.search_left,
            ),
        JSON.stringify(facts),
    );
    await shot_header(page, "light-classic-othello");
    await patch(page, "/json/settings", "web_direct_message_bubbles=true");

    // A failed start shows an error banner, and opens no call.
    await open_view(page, views.othello);
    await page.setRequestInterception(true);
    const fail_start = (request: HTTPRequest): void => {
        if (request.url().endsWith("/json/calls/livekit/start")) {
            void request.respond({
                status: 400,
                contentType: "application/json",
                body: JSON.stringify({result: "error", msg: "Test failure", code: "BAD_REQUEST"}),
            });
        } else {
            void request.continue();
        }
    };
    page.on("request", fail_start);
    const pages_before = (await browser.pages()).length;
    await page.click("#message_view_header .message-view-header-video-call");
    await page.waitForSelector("#popup_banners_wrapper .call-start-error-banner", {visible: true});
    const error = await page.$eval(
        "#popup_banners_wrapper .call-start-error-banner .banner-label",
        (label) => label.textContent?.trim(),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
        "a call that fails to start shows an error banner and closes its window",
        error === "Failed to start the call.: Test failure" &&
            (await browser.pages()).length === pages_before,
        `${error} ${(await browser.pages()).length}/${pages_before}`,
    );
    page.off("request", fail_start);
    await page.setRequestInterception(false);
    await page.click("#popup_banners_wrapper .call-start-error-banner .banner-close-action");

    // Deactivating Othello while his conversation is open hides the
    // buttons, with a search open.
    await page.click("#searchbox .search_icon");
    await page.waitForSelector("#searchbox-input-container .input", {visible: true});
    await page.keyboard.type("hello");
    run_python(
        python_prelude +
            String.raw`do_deactivate_user(user("othello@zulip.com"), acting_user=None)`,
    );
    await page.waitForFunction(
        () =>
            document.querySelector("#message_view_header .message-view-header-call-buttons") ===
            null,
        {polling: 100},
    );
    const search_text = await page.$eval("#searchbox-input-container .input", (input) =>
        input.textContent?.trim(),
    );
    check(
        "deactivating the other person hides the buttons and keeps an open search",
        search_text === "hello",
        search_text,
    );
    await page.keyboard.press("Escape");

    // Othello's group has no one to call either now.
    await open_view(page, views.group);
    check("a group with a deactivated person has no call buttons", !(await has_call_buttons(page)));

    // Changing the call provider hides and shows the buttons.
    await open_view(page, views.hamlet);
    check("Hamlet has call buttons before the provider changes", await has_call_buttons(page));
    await patch(page, "/json/realm", "video_chat_provider=1");
    await page.waitForFunction(
        () =>
            document.querySelector("#message_view_header .message-view-header-call-buttons") ===
            null,
        {polling: 100},
    );
    check("another call provider hides the buttons without a reload", true);
    await patch(page, "/json/realm", "video_chat_provider=10");
    await page.waitForSelector("#message_view_header .message-view-header-call-buttons");
    check("LiveKit shows the buttons again without a reload", true);

    // A narrow window.
    await page.setViewport({width: 480, height: 900});
    await open_view(page, views.hamlet);
    facts = await call_button_facts(page);
    check(
        "in a narrow window the name is cut off before the call buttons",
        facts.buttons.length === 2 &&
            facts.buttons.every(
                (button) => button.left >= facts.title_right && button.right <= facts.search_left,
            ),
        JSON.stringify(facts),
    );
    await shot_header(page, "light-narrow-hamlet");
    await page.setViewport({width: 1280, height: 1000});

    await patch(page, "/json/settings", "color_scheme=2");
    await page.reload();
    await open_view(page, views.hamlet);
    await page.hover("#message_view_header .message-view-header-video-call");
    await page.waitForSelector(".tippy-content", {visible: true});
    await shot_header(page, "dark-hamlet-hover");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(header_calls_test);
