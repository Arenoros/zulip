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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "header";
// Only take screenshots of the classic header, for comparing them
// with the same screenshots taken before these changes.
const classic_only = process.env["CLASSIC_ONLY"] === "1";

function run_python(script: string): string {
    return execSync("./manage.py shell", {input: script, encoding: "utf8"});
}

const python_prelude = String.raw`import json
from datetime import timedelta

from django.conf import settings
from django.utils.timezone import now as timezone_now

from zerver.actions.message_send import internal_send_private_message
from zerver.actions.presence import do_update_user_presence
from zerver.actions.user_settings import do_change_avatar_fields, do_change_full_name
from zerver.actions.users import do_deactivate_user
from zerver.models import UserPresence, UserProfile
from zerver.models.clients import get_client
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.models.users import get_system_bot, get_user_by_delivery_email

realm = get_realm("zulip")
client = get_client("website")


def user(email):
    return get_user_by_delivery_email(email, realm)
`;

// Othello is idle (connected, but not active for ten minutes), Hamlet
// was last active three hours ago, Prospero is deactivated, and there
// are conversations with a bot, with a group, and with many people.
const seed_script =
    python_prelude +
    String.raw`
desdemona = user("desdemona@zulip.com")
othello = user("othello@zulip.com")
hamlet = user("hamlet@zulip.com")
iago = user("iago@zulip.com")
prospero = user("prospero@zulip.com")
welcome_bot = get_system_bot(settings.WELCOME_BOT, realm.id)

do_update_user_presence(
    othello, client, timezone_now() - timedelta(minutes=10), UserPresence.LEGACY_STATUS_ACTIVE_INT
)
do_update_user_presence(othello, client, timezone_now(), UserPresence.LEGACY_STATUS_IDLE_INT)
do_update_user_presence(
    hamlet, client, timezone_now() - timedelta(hours=3), UserPresence.LEGACY_STATUS_ACTIVE_INT
)
do_change_full_name(
    iago,
    "Iago with a very long name that does not fit into the header of the conversation",
    acting_user=None,
    notify=False,
)
do_deactivate_user(prospero, acting_user=None)

internal_send_private_message(othello, desdemona, "Hello from Othello")
internal_send_private_message(welcome_bot, desdemona, "Hello from the bot")
many = [othello, iago, hamlet] + [
    user(email)
    for email in ["cordelia@zulip.com", "aaron@zulip.com", "ZOE@zulip.com", "polonius@zulip.com"]
]

print(
    "SEEDED "
    + json.dumps(
        {
            "desdemona": desdemona.id,
            "othello": othello.id,
            "hamlet": hamlet.id,
            "iago": iago.id,
            "prospero": prospero.id,
            "welcome_bot": welcome_bot.id,
            "many": [member.id for member in many],
            "denmark": get_stream("Denmark", realm).id,
        }
    )
)
`;

type Seeded = {
    desdemona: number;
    othello: number;
    hamlet: number;
    iago: number;
    prospero: number;
    welcome_bot: number;
    many: number[];
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

type HeaderFacts = {
    conversation: boolean;
    title: string;
    subtitle: string | undefined;
    subtitle_shown: boolean;
    avatars: {left: number; right: number; top: number; bottom: number; radius: string}[];
    circle: string | undefined;
    circle_box: {left: number; right: number; top: number; bottom: number} | undefined;
    header: {top: number; bottom: number; right: number};
    text_right: number;
    search_left: number;
    title_truncated: boolean;
};

async function header_facts(page: Page): Promise<HeaderFacts> {
    return await page.evaluate(() => {
        const header = document.querySelector("#message_view_header")!;
        const conversation = header.querySelector(".conversation-header");
        const title = header.querySelector(".message-header-navbar-title")!;
        const subtitle = header.querySelector(".conversation-header-subtitle");
        const circle = header.querySelector(".conversation-header-presence");
        const box = (element: Element): {left: number; right: number; top: number; bottom: number} => {
            const rect = element.getBoundingClientRect();
            return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
        };
        const header_rect = header.getBoundingClientRect();
        return {
            conversation: conversation !== null,
            title: title.textContent!.trim(),
            subtitle: subtitle?.textContent?.trim(),
            subtitle_shown: subtitle !== null && getComputedStyle(subtitle).display !== "none",
            avatars: [...header.querySelectorAll(".conversation-header-avatar")].map((avatar) => ({
                ...box(avatar),
                radius: getComputedStyle(avatar).borderTopLeftRadius,
            })),
            circle: circle
                ? [...circle.classList].find((name) => name.startsWith("user-circle-"))
                : undefined,
            circle_box: circle ? box(circle) : undefined,
            header: {top: header_rect.top, bottom: header_rect.bottom, right: header_rect.right},
            text_right: (conversation ?? title).getBoundingClientRect().right,
            search_left: document
                .querySelector("#searchbox .search_icon")!
                .getBoundingClientRect().left,
            title_truncated: title.scrollWidth > title.clientWidth,
        };
    });
}

function dm_hash(user_ids: number[]): string {
    return `#narrow/dm/${user_ids.join(",")}-dm`;
}

async function header_test(page: Page): Promise<void> {
    const seeded = JSON.parse(run_python(seed_script).split("SEEDED ")[1]!) as Seeded;

    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await common.log_in(page);
    await page.waitForSelector("#message_view_header", {visible: true});
    await page.setViewport({width: 1280, height: 1000});
    // The sizes of the design, at 15px/1em.
    await set_setting(
        page,
        "color_scheme=3&web_direct_message_bubbles=true&web_font_size_px=15&web_line_height_percent=140",
    );
    await page.reload();

    const views: Record<string, string> = {
        othello: dm_hash([seeded.othello]),
        hamlet: dm_hash([seeded.hamlet]),
        bot: dm_hash([seeded.welcome_bot]),
        self: dm_hash([seeded.desdemona]),
        deactivated: dm_hash([seeded.prospero]),
        group: dm_hash([seeded.othello, seeded.hamlet]),
        many: dm_hash(seeded.many),
        channel: `#narrow/channel/${seeded.denmark}-Denmark`,
    };

    if (classic_only) {
        await set_setting(page, "web_direct_message_bubbles=false");
        for (const [name, hash] of Object.entries(views)) {
            await open_view(page, hash);
            await shot_header(page, `classic-header-${name}`);
        }
        return;
    }

    // One on one: avatar, presence, name and status.
    await open_view(page, views["othello"]!);
    await page.waitForSelector("#message_view_header .conversation-header-avatar");
    let facts = await header_facts(page);
    const avatar = facts.avatars[0]!;
    check(
        "a direct message conversation shows the person in the header",
        facts.conversation &&
            facts.title === "Othello, the Moor of Venice" &&
            facts.avatars.length === 1 &&
            Math.abs(avatar.right - avatar.left - 32) < 0.5 &&
            avatar.radius === "50%",
        JSON.stringify(facts),
    );
    check(
        "an idle person has the idle circle and status",
        facts.circle === "user-circle-idle" && facts.subtitle === "Direct messages · Idle",
        `${facts.circle} ${facts.subtitle}`,
    );
    const centered =
        Math.abs(
            (avatar.top + avatar.bottom) / 2 - (facts.header.top + facts.header.bottom) / 2,
        ) < 1;
    const circle = facts.circle_box!;
    // The center of the presence circle lies on the edge of the round
    // avatar, at its lower right.
    const radius = (avatar.right - avatar.left) / 2;
    const offset = {
        x: (circle.left + circle.right) / 2 - (avatar.left + avatar.right) / 2,
        y: (circle.top + circle.bottom) / 2 - (avatar.top + avatar.bottom) / 2,
    };
    check(
        "the avatar is centered in the header with the circle on its lower right edge",
        centered &&
            Math.abs(Math.hypot(offset.x, offset.y) - radius) < 1.5 &&
            Math.abs(offset.x - offset.y) < 1.5 &&
            offset.x > 0,
        JSON.stringify({avatar, circle, header: facts.header, offset}),
    );
    await shot_header(page, "light-othello-idle");

    // Presence updates live, also with a search open in the header.
    await page.click("#searchbox .search_icon");
    await page.waitForSelector("#searchbox-input-container .input", {visible: true});
    await page.keyboard.type("hello");
    run_python(
        python_prelude +
            String.raw`
do_update_user_presence(
    user("othello@zulip.com"),
    client,
    timezone_now(),
    UserPresence.LEGACY_STATUS_ACTIVE_INT,
    force_send_update=True,
)
`,
    );
    await page.waitForSelector("#message_view_header .conversation-header-presence.user-circle-active");
    const search_text = await page.$eval("#searchbox-input-container .input", (input) =>
        input.textContent?.trim(),
    );
    check("a presence update keeps an open search", search_text === "hello", search_text);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#message_view_header .conversation-header", {visible: true});
    facts = await header_facts(page);
    check(
        "an active person has the active circle and status",
        facts.circle === "user-circle-active" && facts.subtitle === "Direct messages · Active now",
        `${facts.circle} ${facts.subtitle}`,
    );
    await shot_header(page, "light-othello-active");

    // Name and avatar update live.
    const old_avatar = await page.$eval(
        "#message_view_header .conversation-header-avatar",
        (img) => img.getAttribute("src"),
    );
    run_python(
        python_prelude +
            String.raw`
othello = user("othello@zulip.com")
do_change_full_name(othello, "Othello Renamed", acting_user=None, notify=True)
do_change_avatar_fields(othello, UserProfile.AVATAR_FROM_GRAVATAR, acting_user=None)
`,
    );
    await page.waitForFunction(
        (old: string | null) =>
            document
                .querySelector("#message_view_header .conversation-header-avatar")
                ?.getAttribute("src") !== old,
        {polling: 100},
        old_avatar,
    );
    facts = await header_facts(page);
    check(
        "a new name and avatar show without a reload",
        facts.title === "Othello Renamed" && facts.conversation,
        facts.title,
    );

    // Someone last active hours ago, then deactivated live.
    await open_view(page, views["hamlet"]!);
    facts = await header_facts(page);
    check(
        "an offline person has the offline circle and when they were last active",
        facts.circle === "user-circle-offline" &&
            facts.subtitle!.startsWith("Direct messages · Active ") &&
            facts.subtitle!.endsWith(" ago"),
        `${facts.circle} ${facts.subtitle}`,
    );
    await shot_header(page, "light-hamlet");

    // A bot, oneself, and a deactivated user.
    await open_view(page, views["bot"]!);
    facts = await header_facts(page);
    check(
        "a bot is labeled as a bot, without presence",
        facts.subtitle === "Direct messages · Bot" && facts.circle === undefined,
        `${facts.circle} ${facts.subtitle}`,
    );
    await shot_header(page, "light-bot");

    await open_view(page, views["self"]!);
    facts = await header_facts(page);
    check(
        "a conversation with oneself keeps its title",
        facts.title === "Messages with yourself" &&
            facts.subtitle === "Direct messages" &&
            facts.avatars.length === 1 &&
            facts.circle === undefined,
        JSON.stringify(facts),
    );
    await shot_header(page, "light-self");

    await open_view(page, views["deactivated"]!);
    facts = await header_facts(page);
    check(
        "a deactivated user is marked as such",
        facts.circle === "user-circle-deactivated" &&
            facts.subtitle === "Direct messages · This user has been deactivated.",
        `${facts.circle} ${facts.subtitle}`,
    );
    await shot_header(page, "light-deactivated");

    // Groups: two overlapping avatars and the number of participants.
    await open_view(page, views["group"]!);
    facts = await header_facts(page);
    const [first, second] = facts.avatars;
    check(
        "a group shows two overlapping avatars and the number of participants",
        facts.avatars.length === 2 &&
            Math.abs(first!.right - first!.left - 28) < 0.5 &&
            second!.left < first!.right &&
            second!.left > first!.left &&
            facts.subtitle === "Group chat · 3 participants" &&
            facts.circle === undefined,
        JSON.stringify(facts),
    );
    await shot_header(page, "light-group");

    await open_view(page, views["many"]!);
    facts = await header_facts(page);
    check(
        "many long names are cut off before the search box",
        facts.title_truncated &&
            facts.text_right <= facts.search_left &&
            facts.subtitle === "Group chat · 8 participants",
        JSON.stringify(facts),
    );
    await shot_header(page, "light-many");

    // A narrow window, and a short window with a short header.
    await page.setViewport({width: 480, height: 900});
    await open_view(page, views["many"]!);
    facts = await header_facts(page);
    check(
        "a narrow window cuts off the names too",
        facts.title_truncated && facts.text_right <= facts.search_left,
        JSON.stringify(facts),
    );
    await shot_header(page, "light-narrow-many");
    await open_view(page, views["othello"]!);
    await shot_header(page, "light-narrow-othello");

    await page.setViewport({width: 1280, height: 560});
    await open_view(page, views["othello"]!);
    facts = await header_facts(page);
    const short_avatar = facts.avatars[0]!;
    check(
        "a short header shows the name only, with a smaller avatar",
        !facts.subtitle_shown &&
            Math.abs(short_avatar.right - short_avatar.left - 24) < 0.5 &&
            short_avatar.bottom <= facts.header.bottom,
        JSON.stringify(facts),
    );
    await shot_header(page, "light-short");
    await page.setViewport({width: 1280, height: 1000});

    // Hamlet is deactivated while his conversation is open.
    await open_view(page, views["hamlet"]!);
    run_python(python_prelude + String.raw`do_deactivate_user(user("hamlet@zulip.com"), acting_user=None)`);
    await page.waitForSelector(
        "#message_view_header .conversation-header-presence.user-circle-deactivated",
    );
    check("deactivating someone updates the header without a reload", true);

    // The setting switches the header without a reload.
    await open_view(page, views["othello"]!);
    await set_setting(page, "web_direct_message_bubbles=false");
    await page.waitForFunction(
        () => document.querySelector("#message_view_header .conversation-header") === null,
        {polling: 100},
    );
    facts = await header_facts(page);
    const icon = await page.$("#message_view_header .navbar-icon");
    check(
        "turning the setting off restores the classic header",
        !facts.conversation && icon !== null && facts.title === "Othello Renamed",
        JSON.stringify(facts),
    );
    await set_setting(page, "web_direct_message_bubbles=true");
    await page.waitForSelector("#message_view_header .conversation-header");
    check("turning the setting on again shows the conversation header", true);

    await open_view(page, views["channel"]!);
    facts = await header_facts(page);
    check("channels keep the classic header", !facts.conversation, facts.title);

    await set_setting(page, "color_scheme=2");
    await page.reload();
    for (const name of ["othello", "group", "bot"]) {
        await open_view(page, views[name]!);
        await shot_header(page, `dark-${name}`);
    }

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(header_test);
