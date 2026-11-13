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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "compose-for-view";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

// Othello writes three times, and there are conversations with Hamlet,
// with a group, with a deactivated user, and a topic in Denmark.
const seed_script = String.raw`import json

from zerver.actions.message_send import internal_send_private_message, internal_send_stream_message
from zerver.actions.users import do_deactivate_user
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")


def user(email):
    return get_user_by_delivery_email(email, realm)


desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
hamlet = user("hamlet@zulip.com")
prospero = user("prospero@zulip.com")
denmark = get_stream("Denmark", realm)

for text in ["First from Othello", "Second from Othello", "Third from Othello"]:
    internal_send_private_message(othello, desdemona, text)
internal_send_private_message(hamlet, desdemona, "Hello from Hamlet")
internal_send_private_message(prospero, desdemona, "Hello from Prospero")
do_deactivate_user(prospero, acting_user=None)
internal_send_stream_message(othello, denmark, "castle", "Meet at the castle")

print(
    "SEEDED "
    + json.dumps(
        {
            "desdemona": desdemona.id,
            "othello": othello.id,
            "hamlet": hamlet.id,
            "prospero": prospero.id,
            "denmark": denmark.id,
        }
    )
)
`;

type Seeded = {
    desdemona: number;
    othello: number;
    hamlet: number;
    prospero: number;
    denmark: number;
};

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

// Goes to a view inside the app, without reloading it.
async function go_to(page: Page, hash: string): Promise<void> {
    await page.evaluate((hash) => {
        window.location.hash = hash;
    }, hash);
    await page.waitForFunction(
        (hash) => decodeURIComponent(window.location.hash) === decodeURIComponent(hash),
        {},
        hash,
    );
    // Let the narrow settle.
    await new Promise((resolve) => setTimeout(resolve, 700));
}

type ComposeFacts = {
    open: boolean;
    for_view: boolean;
    recipient_row_shown: boolean;
    close_shown: boolean;
    closed_controls_shown: boolean;
    placeholder: string;
    content: string;
    focused: boolean;
};

async function compose_facts(page: Page): Promise<ComposeFacts> {
    return await page.evaluate(() => {
        const compose = document.querySelector("#compose")!;
        const shown = (selector: string): boolean => {
            const element = document.querySelector<HTMLElement>(selector);
            return element !== null && element.offsetParent !== null;
        };
        const textarea = document.querySelector<HTMLTextAreaElement>("textarea#compose-textarea")!;
        return {
            open: compose.classList.contains("compose-box-open"),
            for_view: compose.classList.contains("compose-for-view"),
            recipient_row_shown: shown("#compose-recipient"),
            close_shown: shown("#compose_close"),
            closed_controls_shown: shown("#closed-compose-controls"),
            placeholder: textarea.placeholder,
            content: textarea.value,
            focused: document.activeElement === textarea,
        };
    });
}

function is_view_compose(facts: ComposeFacts): boolean {
    return (
        facts.open &&
        facts.for_view &&
        !facts.recipient_row_shown &&
        !facts.close_shown &&
        !facts.closed_controls_shown
    );
}

async function selected_message_id(page: Page): Promise<string | null> {
    return await page.evaluate(
        () => document.querySelector(".selected_message")?.getAttribute("data-message-id") ?? null,
    );
}

function dm_hash(user_ids: number[]): string {
    return `#narrow/dm/${user_ids.join(",")}-dm`;
}

async function compose_for_view_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;

    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await common.log_in(page);
    await page.waitForSelector("#message_view_header", {visible: true});
    await page.setViewport({width: 1280, height: 1000});
    await set_setting(page, "color_scheme=3&web_font_size_px=15&web_line_height_percent=140");
    await page.reload();
    await page.waitForSelector("#message_view_header", {visible: true});

    const othello = dm_hash([seeded.othello]);
    const hamlet = dm_hash([seeded.hamlet]);

    // A direct message conversation: the compose box is open, without
    // a recipient row, and the keyboard stays with the message feed.
    await go_to(page, othello);
    let facts = await compose_facts(page);
    check(
        "a direct message conversation has the compose box open for it",
        is_view_compose(facts) && facts.placeholder === "Message Othello, the Moor of Venice",
        JSON.stringify(facts),
    );
    check("opening the conversation does not focus the compose box", !facts.focused);
    await common.screenshot(page, `${shot_prefix}-light-othello`);

    const before = await selected_message_id(page);
    await page.keyboard.press("KeyJ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await selected_message_id(page);
    check(
        "j moves through the messages",
        before !== null && after !== null && after !== before,
        `${before} ${after}`,
    );

    await page.keyboard.press("KeyR");
    await page.waitForFunction(
        () => document.activeElement === document.querySelector("textarea#compose-textarea"),
    );
    check("r focuses the compose box", true);
    await page.keyboard.type("Draft for Othello");
    await page.keyboard.press("Escape");
    facts = await compose_facts(page);
    check(
        "Esc takes the focus away and keeps the text",
        is_view_compose(facts) && !facts.focused && facts.content === "Draft for Othello",
        JSON.stringify(facts),
    );
    // With the focus elsewhere, Esc does what it does in any view.
    await page.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const hash_after_escape = await page.evaluate(() => window.location.hash);
    check(
        "a second Esc goes to the home view",
        decodeURIComponent(hash_after_escape) !== decodeURIComponent(othello),
        hash_after_escape,
    );
    await go_to(page, othello);

    await page.click("textarea#compose-textarea");
    facts = await compose_facts(page);
    check("clicking the compose box focuses it", facts.focused);
    await page.click(".message_row .message_content");
    facts = await compose_facts(page);
    check(
        "clicking a message keeps the compose box open with its text",
        is_view_compose(facts) && facts.content === "Draft for Othello",
        JSON.stringify(facts),
    );

    // Each conversation has its own draft.
    await go_to(page, hamlet);
    facts = await compose_facts(page);
    check(
        "another conversation has its own empty compose box",
        is_view_compose(facts) &&
            facts.content === "" &&
            facts.placeholder === "Message King Hamlet" &&
            !facts.focused,
        JSON.stringify(facts),
    );
    await go_to(page, othello);
    facts = await compose_facts(page);
    check(
        "coming back restores the draft",
        is_view_compose(facts) && facts.content.trim() === "Draft for Othello" && !facts.focused,
        JSON.stringify(facts),
    );

    // A new direct message shows the recipient row, and closing it
    // brings back the compose box of the conversation.
    await page.keyboard.press("KeyX");
    await page.waitForSelector("#compose-recipient", {visible: true});
    facts = await compose_facts(page);
    check(
        "x opens a compose box with a recipient row",
        facts.open && !facts.for_view && facts.recipient_row_shown && facts.content === "",
        JSON.stringify(facts),
    );
    await common.pm_recipient.set(page, "cordelia@zulip.com");
    await page.waitForSelector("#compose-direct-recipient .pill", {visible: true});
    check("the recipient typeahead works there", true);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#compose.compose-for-view");
    facts = await compose_facts(page);
    check(
        "closing it brings back the compose box of the conversation with its draft",
        is_view_compose(facts) &&
            facts.placeholder === "Message Othello, the Moor of Venice" &&
            facts.content.trim() === "Draft for Othello" &&
            !facts.focused,
        JSON.stringify(facts),
    );

    // Other single conversations.
    const views: [string, string, string][] = [
        [
            "group",
            dm_hash([seeded.othello, seeded.hamlet]),
            "Message King Hamlet and Othello, the Moor of Venice",
        ],
        ["self", dm_hash([seeded.desdemona]), "Write yourself a note"],
        [
            "topic",
            `#narrow/channel/${seeded.denmark}-Denmark/topic/castle`,
            "Message #Denmark > castle",
        ],
    ];
    for (const [name, hash, placeholder] of views) {
        await go_to(page, hash);
        facts = await compose_facts(page);
        check(
            `${name}: the compose box is open for the conversation`,
            is_view_compose(facts) && facts.placeholder === placeholder && !facts.focused,
            JSON.stringify(facts),
        );
    }
    await common.screenshot(page, `${shot_prefix}-light-topic`);

    // Someone one cannot write to: Zulip keeps the compose box, and
    // says why when sending.
    await go_to(page, dm_hash([seeded.prospero]));
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("Hello Prospero");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#compose_banners .deactivated_user", {visible: true});
    facts = await compose_facts(page);
    check(
        "a deactivated user's conversation says that one cannot write there",
        is_view_compose(facts),
        JSON.stringify(facts),
    );
    await page.evaluate(() => {
        document.querySelector<HTMLTextAreaElement>("textarea#compose-textarea")!.value = "";
    });

    // Views of several conversations keep the classic compose box.
    const mixed: [string, string][] = [
        ["combined feed", "#feed"],
        ["mentions", "#narrow/is/mentioned"],
        ["starred", "#narrow/is/starred"],
        ["search", "#narrow/search/castle"],
        ["inbox", "#inbox"],
        ["recent conversations", "#recent"],
    ];
    for (const [name, hash] of mixed) {
        await go_to(page, hash);
        facts = await compose_facts(page);
        check(
            `${name}: the compose box is closed`,
            !facts.open && !facts.for_view && facts.closed_controls_shown,
            JSON.stringify(facts),
        );
    }

    // What was typed stays when leaving for a view of several
    // conversations, with the recipient row shown there.
    await go_to(page, othello);
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("and more");
    await go_to(page, "#feed");
    facts = await compose_facts(page);
    check(
        "the text stays in the combined feed, with the recipient row",
        facts.open &&
            !facts.for_view &&
            facts.recipient_row_shown &&
            facts.content.trim() === "Draft for Othello and more",
        JSON.stringify(facts),
    );
    await go_to(page, hamlet);
    facts = await compose_facts(page);
    check(
        "going to another conversation then gives its own compose box",
        is_view_compose(facts) && facts.content === "",
        JSON.stringify(facts),
    );

    // Sending keeps the compose box open, empty, without a banner
    // about the message being sent elsewhere.
    await page.click("textarea#compose-textarea");
    await page.keyboard.type("Hello Hamlet");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll(".message_content")].some((content) =>
                content.textContent?.includes("Hello Hamlet"),
            ),
        {polling: 100},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    facts = await compose_facts(page);
    const banners = await page.$$eval("#compose_banners .main-view-banner", (elements) =>
        elements.map((element) => element.textContent?.trim()),
    );
    check(
        "sending keeps the compose box open and empty, without banners",
        is_view_compose(facts) && facts.content === "" && banners.length === 0,
        `${JSON.stringify(facts)} ${JSON.stringify(banners)}`,
    );

    // A narrow window.
    await page.setViewport({width: 480, height: 900});
    await go_to(page, othello);
    facts = await compose_facts(page);
    check(
        "a narrow window has the compose box for the view",
        is_view_compose(facts),
        JSON.stringify(facts),
    );
    await common.screenshot(page, `${shot_prefix}-light-narrow-othello`);
    await page.setViewport({width: 1280, height: 1000});

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(compose_for_view_test);
