import {execSync} from "node:child_process";

import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "header-people";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json

from zerver.actions.message_send import internal_send_private_message
from zerver.actions.create_user import do_reactivate_user
from zerver.actions.users import do_deactivate_user
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)
`;

// Prospero is deactivated.
const seed_script =
    python_prelude +
    String.raw`
desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
hamlet = user("hamlet@zulip.com")
cordelia = user("cordelia@zulip.com")
prospero = user("prospero@zulip.com")

do_deactivate_user(prospero, acting_user=None)
internal_send_private_message(othello, desdemona, "Hello from Othello")

print(
    "SEEDED "
    + json.dumps(
        {
            "desdemona": desdemona.id,
            "othello": othello.id,
            "hamlet": hamlet.id,
            "cordelia": cordelia.id,
            "prospero": prospero.id,
            "denmark": get_stream("Denmark", realm).id,
        }
    )
)
`;

type Seeded = {
    desdemona: number;
    othello: number;
    hamlet: number;
    cordelia: number;
    prospero: number;
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

async function shot(page: Page, name: string, selector = "#header-container"): Promise<void> {
    // Let avatars and fonts settle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.evaluate((selector) => {
        const rects = [...document.querySelectorAll(selector)].map((element) =>
            element.getBoundingClientRect(),
        );
        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        // Clips are measured from the top of the page, which can be
        // scrolled in a message feed.
        return {
            x: Math.max(0, left - 4),
            y: Math.max(0, top - 4) + window.scrollY,
            width: Math.max(...rects.map((rect) => rect.right)) - left + 8,
            height: Math.max(...rects.map((rect) => rect.bottom)) - top + 8,
        };
    }, selector);
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

type HeaderFacts = {
    navbar_height: number;
    header_height: number;
    buttons: string[];
    buttons_centered: boolean;
    buttons_after_title: boolean;
    buttons_before_search: boolean;
    search_centered: boolean;
};

async function header_facts(page: Page): Promise<HeaderFacts> {
    return await page.evaluate(() => {
        const header = document.querySelector("#message_view_header")!;
        const header_rect = header.getBoundingClientRect();
        const middle = (header_rect.top + header_rect.bottom) / 2;
        const buttons = [
            ...header.querySelectorAll<HTMLElement>(".message-view-header-buttons .icon-button"),
        ];
        const title_right =
            header.querySelector(".message-header-navbar-title")?.getBoundingClientRect().right ??
            header_rect.left;
        const search = document.querySelector("#searchbox .search_icon")!.getBoundingClientRect();
        const centered = (rect: DOMRect): boolean =>
            Math.abs((rect.top + rect.bottom) / 2 - middle) < 1;
        return {
            navbar_height: document.querySelector("#navbar-middle")!.getBoundingClientRect().height,
            header_height: header_rect.height,
            buttons: buttons.map((button) => button.getAttribute("aria-label") ?? ""),
            buttons_centered: buttons.every((button) => centered(button.getBoundingClientRect())),
            buttons_after_title: buttons.every(
                (button) => button.getBoundingClientRect().left >= title_right,
            ),
            buttons_before_search: buttons.every(
                (button) => button.getBoundingClientRect().right <= search.left,
            ),
            search_centered: centered(search),
        };
    });
}

type PopoverFacts = {
    heading: string;
    names: string[];
    captions: string[];
    presence: boolean[];
    start_group_chat: boolean;
    below_button: boolean;
};

async function open_people_popover(page: Page): Promise<PopoverFacts> {
    await page.click("#message_view_header .message-view-header-people-button");
    await page.waitForSelector(".conversation-people-popover", {visible: true});
    return await page.evaluate(() => {
        const popover = document.querySelector(".conversation-people-popover")!;
        const members = [...popover.querySelectorAll(".conversation-people-member")];
        const button = document
            .querySelector("#message_view_header .message-view-header-people-button")!
            .getBoundingClientRect();
        return {
            heading: popover.querySelector(".conversation-people-heading")!.textContent.trim(),
            names: members.map(
                (member) =>
                    member.querySelector(".conversation-people-name")!.textContent.trim(),
            ),
            captions: members.map(
                (member) =>
                    member.querySelector(".conversation-people-caption")?.textContent.trim() ??
                    "",
            ),
            presence: members.map(
                (member) => member.querySelector(".conversation-people-presence") !== null,
            ),
            start_group_chat:
                popover.querySelector(".conversation-people-start-group-chat") !== null,
            below_button: popover.getBoundingClientRect().top >= button.bottom,
        };
    });
}

async function close_popover(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
        () => document.querySelector(".conversation-people-popover") === null,
        {polling: 100},
    );
}

async function has_people_button(page: Page): Promise<boolean> {
    return (await page.$("#message_view_header .message-view-header-people-button")) !== null;
}

async function typeahead_names(page: Page): Promise<string[]> {
    return await page.$$eval(".tippy-content .typeahead.dropdown-menu .typeahead-strong-section", (items) =>
        items.map((item) => item.textContent.trim()),
    );
}

function dm_hash(user_ids: number[]): string {
    return `#narrow/dm/${user_ids.join(",")}-dm`;
}

async function header_people_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;

    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await common.log_in(page);
    await page.waitForSelector("#message_view_header", {visible: true});
    await page.setViewport({width: 1280, height: 1000});
    await patch(page, "/json/realm", "video_chat_provider=10");
    await patch(
        page,
        "/json/settings",
        "color_scheme=3&web_direct_message_bubbles=true&web_font_size_px=16&web_line_height_percent=140",
    );
    await page.reload();

    const views = {
        othello: dm_hash([seeded.othello]),
        cordelia: dm_hash([seeded.cordelia]),
        group: dm_hash([seeded.othello, seeded.hamlet]),
        self: dm_hash([seeded.desdemona]),
        deactivated: dm_hash([seeded.prospero]),
        channel: `#narrow/channel/${seeded.denmark}-Denmark`,
        topic: `#narrow/channel/${seeded.denmark}-Denmark/topic/people`,
    };

    // The header is 48px tall, with everything in it centered.
    await open_view(page, views.othello);
    let facts = await header_facts(page);
    check(
        "the header is 48px tall",
        facts.navbar_height === 48 && facts.header_height === 48,
        JSON.stringify(facts),
    );
    check(
        "a one-on-one conversation has call buttons, then the people button",
        JSON.stringify(facts.buttons) === JSON.stringify(["Video call", "Voice call", "People"]),
        JSON.stringify(facts.buttons),
    );
    check(
        "the buttons sit between the name and the search, centered in the header",
        facts.buttons_centered &&
            facts.buttons_after_title &&
            facts.buttons_before_search &&
            facts.search_centered,
        JSON.stringify(facts),
    );
    await shot(page, "light-othello");
    await shot(page, "light-left-sidebar-top", "#left-sidebar-navigation-area, #header-container");

    // The people of a one-on-one conversation.
    let popover = await open_people_popover(page);
    check(
        "the popover lists the current user first, then the other person",
        popover.heading === "People" &&
            JSON.stringify(popover.names) ===
                JSON.stringify(["Desdemona", "Othello, the Moor of Venice"]) &&
            JSON.stringify(popover.captions) === JSON.stringify(["You", ""]) &&
            popover.presence.every(Boolean),
        JSON.stringify(popover),
    );
    check(
        "a one-on-one conversation can start a group chat",
        popover.start_group_chat && popover.below_button,
        JSON.stringify(popover),
    );
    const button_active = await page.$eval(
        "#message_view_header .message-view-header-people-button",
        (button) =>
            button.getAttribute("aria-expanded") === "true" &&
            button.classList.contains("message-view-header-people-button-active"),
    );
    check("the button shows that its popover is open", button_active);
    await shot(page, "light-popover", "#header-container, .conversation-people-popover");

    // A person opens their card.
    await page.click(
        `.conversation-people-member[data-user-id="${seeded.othello}"]`,
    );
    await page.waitForSelector(".popover-menu-user-full-name", {visible: true});
    const card_name = await page.$eval(".popover-menu-user-full-name", (title) =>
        title.textContent.trim(),
    );
    check(
        "clicking a person opens their user card",
        card_name.includes("Othello") &&
            (await page.$(".conversation-people-popover")) === null,
        card_name,
    );
    await shot(page, "light-user-card", "#header-container, #user_card_popover");
    await page.keyboard.press("Escape");
    await page.waitForFunction(
        () => document.querySelector(".popover-menu-user-full-name") === null,
        {polling: 100},
    );

    // Starting a group chat.
    await open_people_popover(page);
    await page.click(".conversation-people-start-group-chat");
    await page.waitForSelector("#start-group-chat-modal .start-group-chat-people .input", {
        visible: true,
    });
    await page.waitForFunction(
        () =>
            document.activeElement ===
            document.querySelector("#start-group-chat-modal .start-group-chat-people .input"),
        {polling: 100},
    );
    const disabled_before = await page.$eval(
        "#start-group-chat-modal .dialog_submit_button",
        (button) => (button as HTMLButtonElement).disabled,
    );
    check("the dialog focuses the input and starts with nobody to add", disabled_before);
    const excluded: string[] = [];
    for (const query of ["Othel", "Desdem"]) {
        await page.keyboard.type(query);
        await new Promise((resolve) => setTimeout(resolve, 500));
        excluded.push(...(await typeahead_names(page)));
        for (const _ of query) {
            await page.keyboard.press("Backspace");
        }
    }
    check(
        "the typeahead leaves out the people already in the conversation",
        excluded.length === 0,
        JSON.stringify(excluded),
    );
    await page.keyboard.type("King Ham");
    await page.waitForFunction(
        () =>
            document
                .querySelector(".tippy-content .typeahead.dropdown-menu .active")
                ?.textContent.includes("King Hamlet"),
        {polling: 100},
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector("#start-group-chat-modal .pill", {visible: true});
    const disabled_after = await page.$eval(
        "#start-group-chat-modal .dialog_submit_button",
        (button) => (button as HTMLButtonElement).disabled,
    );
    check("adding someone enables the Start button", !disabled_after);
    await shot(page, "light-modal", "#start-group-chat-modal");
    await page.click("#start-group-chat-modal .dialog_submit_button");
    await page.waitForFunction(
        () => document.querySelector("#start-group-chat-modal") === null,
        {polling: 100},
    );
    await page.waitForFunction(
        (hash: string) => window.location.hash === hash,
        {polling: 100},
        `#narrow/dm/${[seeded.hamlet, seeded.othello].sort((a, b) => a - b).join(",")}-group`,
    );
    await page.waitForFunction(
        () =>
            document
                .querySelector("#message_view_header .conversation-header-subtitle")
                ?.textContent.includes("3 participants"),
        {polling: 100},
    );
    check("Start opens the group chat with everyone", true);

    // A group lists everyone, and cannot start another group chat yet.
    popover = await open_people_popover(page);
    check(
        "a group chat lists everyone, and has no group chat to start",
        JSON.stringify(popover.names) ===
            JSON.stringify(["Desdemona", "King Hamlet", "Othello, the Moor of Venice"]) &&
            !popover.start_group_chat,
        JSON.stringify(popover),
    );
    await close_popover(page);
    check(
        "Escape returns the focus to the people button",
        await page.evaluate(() =>
            document.activeElement?.classList.contains("message-view-header-people-button") === true,
        ),
    );

    // Notes to self can start a group chat too; a deactivated person cannot.
    await open_view(page, views.self);
    popover = await open_people_popover(page);
    check(
        "notes to self list the current user",
        JSON.stringify(popover.names) === JSON.stringify(["Desdemona"]) &&
            popover.start_group_chat,
        JSON.stringify(popover),
    );
    await close_popover(page);
    await open_view(page, views.deactivated);
    popover = await open_people_popover(page);
    check(
        "a deactivated person cannot be added to a group chat",
        popover.names.length === 2 && !popover.start_group_chat,
        JSON.stringify(popover),
    );
    await close_popover(page);

    for (const name of ["channel", "topic"] as const) {
        await open_view(page, views[name]);
        check(`no people button: ${name}`, !(await has_people_button(page)));
    }

    // The call buttons stay before the people button when they come
    // and go.
    await open_view(page, views.cordelia);
    run_python(python_prelude + String.raw`do_deactivate_user(user("cordelia@zulip.com"), acting_user=None)`);
    await page.waitForFunction(
        () => document.querySelector("#message_view_header .message-view-header-call-buttons") === null,
        {polling: 100},
    );
    facts = await header_facts(page);
    check(
        "deactivating the other person leaves the people button",
        JSON.stringify(facts.buttons) === JSON.stringify(["People"]) && facts.buttons_centered,
        JSON.stringify(facts.buttons),
    );
    run_python(python_prelude + String.raw`do_reactivate_user(user("cordelia@zulip.com"), acting_user=None)`);
    await page.waitForSelector("#message_view_header .message-view-header-call-buttons");
    facts = await header_facts(page);
    check(
        "reactivating them puts the call buttons back before the people button",
        JSON.stringify(facts.buttons) === JSON.stringify(["Video call", "Voice call", "People"]),
        JSON.stringify(facts.buttons),
    );

    // The classic layout gets the button too.
    await patch(page, "/json/settings", "web_direct_message_bubbles=false");
    await open_view(page, views.othello);
    facts = await header_facts(page);
    check(
        "the classic header has the people button after the call buttons",
        JSON.stringify(facts.buttons) === JSON.stringify(["Video call", "Voice call", "People"]) &&
            facts.buttons_centered &&
            facts.buttons_after_title &&
            facts.buttons_before_search,
        JSON.stringify(facts),
    );
    await shot(page, "light-classic-othello");
    await patch(page, "/json/settings", "web_direct_message_bubbles=true");

    // Other views keep a centered 48px header.
    for (const [name, hash] of [
        ["feed", "#feed"],
        ["inbox", "#inbox"],
        ["recent", "#recent"],
        ["channel", views.channel],
        ["topic", views.topic],
    ] as const) {
        await page.goto(`${base_url}${hash}`);
        await page.waitForSelector("#message_view_header", {visible: true});
        await page.mouse.move(1, 1);
        facts = await header_facts(page);
        check(`${name}: the header is 48px tall`, facts.navbar_height === 48, JSON.stringify(facts));
        await shot(page, `light-${name}`);
    }

    // A narrow window.
    await page.setViewport({width: 480, height: 900});
    await open_view(page, views.group);
    facts = await header_facts(page);
    check(
        "in a narrow window the name is cut off before the buttons",
        facts.buttons.length === 3 && facts.buttons_after_title && facts.buttons_before_search,
        JSON.stringify(facts),
    );
    await shot(page, "light-narrow-group");
    await open_people_popover(page);
    await shot(page, "light-narrow-popover", "#header-container, .conversation-people-popover");
    await close_popover(page);

    // A short window keeps the 30px header.
    await page.setViewport({width: 1280, height: 580});
    await open_view(page, views.othello);
    facts = await header_facts(page);
    check(
        "a short window keeps a 30px header with centered buttons",
        facts.navbar_height === 30 && facts.buttons_centered,
        JSON.stringify(facts),
    );
    await shot(page, "light-short-othello");
    await page.setViewport({width: 1280, height: 1000});

    // Dark theme, in Russian.
    await patch(page, "/json/settings", "color_scheme=2&default_language=ru");
    await page.reload();
    await open_view(page, views.othello);
    await shot(page, "dark-ru-othello");
    await open_people_popover(page);
    await shot(page, "dark-ru-popover", "#header-container, .conversation-people-popover");
    await page.click(".conversation-people-start-group-chat");
    await page.waitForSelector("#start-group-chat-modal .start-group-chat-people .input", {
        visible: true,
    });
    await shot(page, "dark-ru-modal", "#start-group-chat-modal");
    await page.keyboard.press("Escape");
    await patch(page, "/json/settings", "color_scheme=3&default_language=en");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(header_people_test);
