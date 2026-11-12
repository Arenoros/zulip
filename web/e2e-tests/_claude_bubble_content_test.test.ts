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

// Seeds a direct message conversation between Desdemona and Othello
// with wide and special content, and a message from a bot to
// Desdemona.
const seed_script = String.raw`import json
from datetime import datetime, timedelta, timezone

from django.conf import settings
from django.db.models import F

from zerver.actions.message_send import internal_send_private_message
from zerver.models import Message, UserMessage
from zerver.models.realms import get_realm
from zerver.models.users import get_system_bot, get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
welcome_bot = get_system_bot(settings.WELCOME_BOT, realm.id)
start = datetime(2026, 11, 10, 18, 0, tzinfo=timezone.utc)

long_text = "\n\n".join(
    f"Paragraph {n}: the client takes a long time to load the project, the "
    "interface stutters, and switching to other tabs is not possible while "
    "the elements are loading."
    for n in range(1, 25)
)

plan = [
    (
        "code",
        othello,
        "Here is how to start it for tests:\n"
        "~~~\n"
        "docker run -d --name nextcloud -p 8080:80 -v nextcloud_data:/var/www/html nextcloud:latest\n"
        "curl -I http://localhost:8080/status.php   # long lines scroll inside the block, the bubble stays in its column\n"
        "~~~",
    ),
    ("own_code", desdemona, "~~~ python\nprint('short')\n~~~"),
    (
        "table",
        othello,
        "What we checked:\n\n"
        "| Client | Chat | Voice | Video |\n"
        "| --- | --- | --- | --- |\n"
        "| Zulip Desktop | direct | opens the browser | pending |\n"
        "| Browser | shared | audible | pending |",
    ),
    (
        "wide_table",
        desdemona,
        "| "
        + " | ".join(f"Column {n}" for n in range(1, 16))
        + " |\n|"
        + " --- |" * 15
        + "\n| "
        + " | ".join(f"value {n}" for n in range(1, 16))
        + " |",
    ),
    ("own_spoiler", desdemona, "~~~ spoiler Call logs\nThe call connected after 3 seconds.\n~~~"),
    (
        "spoiler",
        othello,
        "~~~ spoiler What the browser shows\nThe camera preview and the microphone level.\n~~~",
    ),
    ("quote", desdemona, "~~~ quote\nI can hear you\n~~~\nGreat, so the sound works"),
    ("me", othello, "/me is watching the call in the browser"),
    ("own_me", desdemona, "/me goes to check the video"),
    ("poll", othello, "/poll When do we repeat the call test?\nTonight\nTomorrow morning"),
    ("todo", desdemona, "/todo Check the calls\nSound in the browser\nVideo\nScreen sharing"),
    ("long", othello, long_text),
    ("collapsed", desdemona, "A message that I collapsed."),
    ("youtube", othello, "Look: https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("math", othello, "$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$"),
    ("emoji", desdemona, ":tada: :thumbs_up:"),
    ("link", othello, "Inline math $$x^2$$ and [a link](https://zulip.com/) in a bubble."),
    ("own_link", desdemona, "My [link](https://zulip.com/) in my bubble."),
]

ids = {}
for minutes, (name, sender, content) in enumerate(plan):
    recipient = othello if sender == desdemona else desdemona
    message_id = internal_send_private_message(sender, recipient, content)
    Message.objects.filter(id=message_id).update(date_sent=start + timedelta(minutes=minutes))
    ids[name] = message_id

# A link preview, which the development server cannot fetch.
ids["embed"] = internal_send_private_message(othello, desdemona, "https://example.com/")
Message.objects.filter(id=ids["embed"]).update(
    date_sent=start + timedelta(minutes=len(plan)),
    rendered_content=(
        '<p><a href="https://example.com/">https://example.com/</a></p>'
        '<div class="message_embed">'
        '<a class="message_embed_image" href="https://example.com/"'
        ' style="background-image: url(/static/images/logo/zulip-icon-128x128.png)"></a>'
        '<div class="data-container">'
        '<div class="message_embed_title">'
        '<a href="https://example.com/" title="Example Domain">Example Domain</a></div>'
        '<div class="message_embed_description">For use in examples.</div>'
        "</div></div>"
    ),
)

ids["bot"] = internal_send_private_message(
    welcome_bot,
    desdemona,
    "You can read Zulip one conversation at a time, seeing each message in context.",
)

UserMessage.objects.filter(user_profile=desdemona, message_id__in=ids.values()).update(
    flags=F("flags").bitor(UserMessage.flags.read)
)
UserMessage.objects.filter(user_profile=desdemona, message_id=ids["collapsed"]).update(
    flags=F("flags").bitor(UserMessage.flags.collapsed)
)

print(
    "SEEDED "
    + json.dumps(
        {"ids": ids, "othello": othello.id, "welcome_bot": welcome_bot.id}
    )
)
`;
const shot_prefix = process.env["SHOT_PREFIX"] ?? "content";
// Only take screenshots of the classic layout, for comparing them
// with the same screenshots taken before these changes.
const classic_only = process.env["CLASSIC_ONLY"] === "1";

type Seeded = {
    ids: Record<string, number>;
    othello: number;
    welcome_bot: number;
};

async function shot_list(page: Page, name: string): Promise<void> {
    // Let images and fonts settle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!;
        const rect = list.getBoundingClientRect();
        const top = Math.max(rect.top, 0);
        return {
            x: rect.left + window.scrollX,
            y: top + window.scrollY,
            width: rect.width,
            height: Math.min(rect.bottom, window.innerHeight) - top,
        };
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

const row_selector = (id: number): string =>
    `.focused-message-list .message_row[data-message-id="${id}"]`;

async function shot_row(page: Page, message_id: number, name: string): Promise<void> {
    const selector = row_selector(message_id);
    await page.$eval(selector, (row) => {
        row.scrollIntoView({block: "center"});
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.$eval(selector, (row) => {
        const rect = row.getBoundingClientRect();
        return {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY - 8,
            width: rect.width,
            height: rect.height + 16,
        };
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function open_view(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    // Move the mouse away from the messages.
    await page.mouse.move(1, 1);
}

async function set_setting(page: Page, body: string): Promise<void> {
    await page.evaluate(async (body) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')?.value ??
            "";
        await fetch("/json/settings", {
            method: "PATCH",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-CSRFToken": csrf_token,
            },
            body,
        });
    }, body);
}

async function shot_all(page: Page, ids: Record<string, number>, theme: string): Promise<void> {
    for (const [name, id] of Object.entries(ids)) {
        if (name !== "bot") {
            await shot_row(page, id, `${theme}-${name}`);
        }
    }
}

type Facts = {
    own: boolean;
    // The feed's content box, and its width.
    feed_left: number;
    feed_right: number;
    width: number;
    bubble: {left: number; right: number; top: number; bottom: number} | undefined;
    overflows: boolean;
};

async function facts(page: Page, id: number): Promise<Facts> {
    return await page.$eval(row_selector(id), (row) => {
        const content = row.querySelector(".messagebox-content")!;
        const rect = content.getBoundingClientRect();
        const feed_left = rect.left + Number.parseFloat(getComputedStyle(content).paddingLeft);
        const bubble = row.querySelector(".message_content:not(.status-message)");
        const bubble_rect = bubble?.getBoundingClientRect();
        return {
            own: row.classList.contains("own-message"),
            feed_left,
            feed_right: rect.right,
            width: rect.right - feed_left,
            bubble: bubble_rect && {
                left: bubble_rect.left,
                right: bubble_rect.right,
                top: bubble_rect.top,
                bottom: bubble_rect.bottom,
            },
            overflows: content.scrollWidth > content.clientWidth + 1,
        };
    });
}

// The computed color of a CSS variable.
async function probe(page: Page, variable: string): Promise<string> {
    return await page.evaluate((variable) => {
        const element = document.createElement("span");
        element.style.color = `var(${variable})`;
        document.querySelector(".focused-message-list")!.append(element);
        const color = getComputedStyle(element).color;
        element.remove();
        return color;
    }, variable);
}

// Sizes in em are within a rounding error of the sizes in px of the
// design.
function near(value: string, px: number): boolean {
    return Math.abs(Number.parseFloat(value) - px) < 0.1;
}

async function computed(page: Page, selector: string, property: string): Promise<string> {
    return await page.$eval(
        selector,
        (element, property) => getComputedStyle(element).getPropertyValue(property),
        property,
    );
}

async function check_code_colors(
    page: Page,
    ids: Record<string, number>,
    expected: string,
): Promise<void> {
    const code_background = await computed(
        page,
        `${row_selector(ids["code"]!)} .codehilite pre`,
        "background-color",
    );
    const own_code_background = await computed(
        page,
        `${row_selector(ids["own_code"]!)} .codehilite pre`,
        "background-color",
    );
    check(
        `code blocks have the code block color (${expected})`,
        code_background === expected &&
            own_code_background === expected &&
            code_background === (await probe(page, "--color-background-code-block-in-bubble")),
        `${code_background} ${own_code_background}`,
    );
}

async function content_test(page: Page): Promise<void> {
    const output = execSync("./manage.py shell", {input: seed_script, encoding: "utf8"});
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    const {ids} = seeded;

    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await common.log_in(page);
    await page.setViewport({width: 1280, height: 1000});
    // The sizes of the design, at 15px/1em.
    await set_setting(
        page,
        "color_scheme=3&web_direct_message_bubbles=true&web_font_size_px=15&web_line_height_percent=140",
    );
    await page.reload();
    const conversation = `#narrow/dm/${seeded.othello}-Othello`;
    await open_view(page, conversation);

    // Uploaded media: an image, a gallery of two images, and audio.
    const media = await page.evaluate(async (othello) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')?.value ??
            "";
        async function upload(blob: Blob, name: string): Promise<string> {
            const form = new FormData();
            form.append("file", blob, name);
            const response = await fetch("/json/user_uploads", {
                method: "POST",
                headers: {"X-CSRFToken": csrf_token},
                body: form,
            });
            return ((await response.json()) as {url: string}).url;
        }
        async function image(width: number, height: number, hue: number): Promise<Blob> {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d")!;
            context.fillStyle = `hsl(${hue}deg 60% 50%)`;
            context.fillRect(0, 0, width, height);
            return await new Promise<Blob>((resolve) => {
                canvas.toBlob((blob) => {
                    resolve(blob!);
                }, "image/png");
            });
        }
        // A second of silence as an 8 kHz, 8-bit mono WAV file.
        function silence(): Blob {
            const samples = 8000;
            const buffer = new DataView(new ArrayBuffer(44 + samples));
            const text = (offset: number, value: string): void => {
                for (let i = 0; i < value.length; i += 1) {
                    buffer.setUint8(offset + i, value.codePointAt(i)!);
                }
            };
            text(0, "RIFF");
            buffer.setUint32(4, 36 + samples, true);
            text(8, "WAVEfmt ");
            buffer.setUint32(16, 16, true);
            buffer.setUint16(20, 1, true);
            buffer.setUint16(22, 1, true);
            buffer.setUint32(24, 8000, true);
            buffer.setUint32(28, 8000, true);
            buffer.setUint16(32, 1, true);
            buffer.setUint16(34, 8, true);
            text(36, "data");
            buffer.setUint32(40, samples, true);
            for (let i = 0; i < samples; i += 1) {
                buffer.setUint8(44 + i, 128);
            }
            return new Blob([buffer.buffer], {type: "audio/wav"});
        }
        async function send(content: string): Promise<number> {
            const response = await fetch("/json/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": csrf_token,
                },
                body: `type=direct&to=${JSON.stringify([othello])}&content=${encodeURIComponent(content)}`,
            });
            return ((await response.json()) as {id: number}).id;
        }
        const wide = await upload(await image(1600, 900, 200), "wide.png");
        const first = await upload(await image(800, 600, 30), "first.png");
        const second = await upload(await image(600, 800, 120), "second.png");
        const sound = await upload(silence(), "sound.wav");
        return {
            image: await send(`[wide.png](${wide})`),
            gallery: await send(`[first.png](${first})\n[second.png](${second})`),
            audio: await send(`![sound.wav](${sound})`),
        };
    }, seeded.othello);
    Object.assign(ids, media);
    await page.waitForSelector(`${row_selector(media.gallery)} .message_content img`);
    // Start over from a freshly rendered view, since the feed scrolls
    // to new messages.
    await page.reload();
    await open_view(page, conversation);
    await page.waitForSelector(`${row_selector(ids["poll"]!)} .widget-content`);
    await page.waitForSelector(`${row_selector(media.gallery)} .message_content img`);

    if (classic_only) {
        await set_setting(page, "web_direct_message_bubbles=false");
        await page.reload();
        await open_view(page, conversation);
        await page.waitForSelector(`${row_selector(media.gallery)} .message_content img`);
        await shot_all(page, ids, "classic");
        await open_view(page, `#narrow/dm/${seeded.welcome_bot}-Welcome-Bot`);
        await shot_row(page, ids["bot"]!, "classic-bot");
        return;
    }

    const all: Record<string, Facts> = {};
    for (const [name, id] of Object.entries(ids)) {
        if (name !== "bot") {
            all[name] = await facts(page, id);
        }
    }

    // Wide content stretches the bubble to 85% of the feed.
    for (const name of [
        "code",
        "own_code",
        "table",
        "wide_table",
        "own_spoiler",
        "spoiler",
        "poll",
        "todo",
        "long",
    ]) {
        const row = all[name]!;
        const bubble = row.bubble!;
        const free_edge = row.own ? bubble.left : bubble.right;
        const expected = row.feed_left + (row.own ? 0.15 : 0.85) * row.width;
        const sender_edge = row.own ? bubble.right - row.feed_right : bubble.left - row.feed_left;
        check(
            `the ${name} bubble takes the whole column`,
            Math.abs(free_edge - expected) < 2 && Math.abs(Math.abs(sender_edge) - (row.own ? 0 : 42)) < 3,
            `${Math.round(free_edge)} vs ${Math.round(expected)}, ${Math.round(sender_edge)}`,
        );
    }
    for (const name of [
        "quote",
        "embed",
        "link",
        "own_link",
        "emoji",
        "math",
        "youtube",
        "image",
        "gallery",
        "audio",
    ]) {
        const row = all[name]!;
        const width = row.bubble!.right - row.bubble!.left;
        check(
            `the ${name} bubble keeps the width of its content`,
            width < 0.85 * row.width - 60,
            `${Math.round(width)} of ${Math.round(row.width)}`,
        );
    }
    const overflowing = Object.entries(all)
        .filter(([, row]) => row.overflows)
        .map(([name]) => name);
    check("nothing overflows the feed", overflowing.length === 0, overflowing.join(", "));

    // Code blocks scroll inside the bubble.
    const code = await page.$eval(`${row_selector(ids["code"]!)} .codehilite pre`, (pre) => ({
        scrolls: pre.scrollWidth > pre.clientWidth,
        radius: getComputedStyle(pre).borderTopLeftRadius,
        font_size: getComputedStyle(pre).fontSize,
    }));
    check(
        "long code lines scroll inside the block",
        code.scrolls && code.radius === "6px" && near(code.font_size, 13),
        JSON.stringify(code),
    );
    await check_code_colors(page, ids, "rgb(246, 248, 250)");

    // Tables: a rounded frame, the header on a background, horizontal
    // scrolling.
    const table = await page.$eval(`${row_selector(ids["table"]!)} table`, (table) => ({
        radius: getComputedStyle(table).borderTopLeftRadius,
        header: getComputedStyle(table.querySelector("thead")!).backgroundColor,
        font_size: getComputedStyle(table).fontSize,
        vertical_lines: getComputedStyle(table.querySelector("td")!).borderLeftWidth,
    }));
    check(
        "tables have a rounded frame and a header background",
        table.radius === "6px" &&
            table.header !== "rgba(0, 0, 0, 0)" &&
            near(table.font_size, 14) &&
            table.vertical_lines === "0px",
        JSON.stringify(table),
    );
    const wide_table = await page.$eval(
        `${row_selector(ids["wide_table"]!)} table`,
        (table) => table.scrollWidth > table.clientWidth,
    );
    check("a wide table scrolls inside the bubble", wide_table);

    // Quotes: a plate with a bar on the left.
    const quote = await page.$eval(`${row_selector(ids["quote"]!)} blockquote`, (quote) => ({
        bar: getComputedStyle(quote).borderInlineStartWidth,
        background: getComputedStyle(quote).backgroundColor,
    }));
    check(
        "quotes are a plate with a 3px bar",
        quote.bar === "3px" && quote.background !== "rgba(0, 0, 0, 0)",
        JSON.stringify(quote),
    );

    // /me messages have no bubble, a 20px avatar, and one's own is on
    // the right.
    const me = await page.$eval(row_selector(ids["me"]!), (row) => ({
        background: getComputedStyle(row.querySelector(".status-message")!).backgroundColor,
        italic: getComputedStyle(row.querySelector(".status-message")!).fontStyle,
        avatar: row.querySelector(".message-avatar img")!.getBoundingClientRect().width,
        time_after_text:
            row.querySelector(".message-time")!.getBoundingClientRect().left -
            row.querySelector(".message_sender")!.getBoundingClientRect().right,
    }));
    check(
        "a /me message has no bubble and a 20px avatar",
        me.background === "rgba(0, 0, 0, 0)" &&
            me.italic === "italic" &&
            near(String(me.avatar), 20) &&
            me.time_after_text >= 0 &&
            me.time_after_text < 2,
        JSON.stringify(me),
    );
    const own_me = await page.$eval(row_selector(ids["own_me"]!), (row) => ({
        avatar: getComputedStyle(row.querySelector(".message-avatar")!).display,
        right: row.querySelector(".message_sender")!.getBoundingClientRect().right,
        time_before_text:
            row.querySelector(".message_sender")!.getBoundingClientRect().left -
            row.querySelector(".message-time")!.getBoundingClientRect().right,
    }));
    check(
        "one's own /me message is on the right, without an avatar",
        own_me.avatar === "none" &&
            Math.abs(own_me.right - all["own_me"]!.feed_right) < 2 &&
            own_me.time_before_text >= 0 &&
            own_me.time_before_text < 2,
        JSON.stringify(own_me),
    );

    // Media inside bubbles.
    const audio = await page.$(`${row_selector(media.audio)} .message_content audio`);
    check("audio plays inside the bubble", audio !== null);

    // Link colors.
    const link_colors = {
        other: await computed(page, `${row_selector(ids["link"]!)} .message_content a`, "color"),
        own: await computed(page, `${row_selector(ids["own_link"]!)} .message_content a`, "color"),
    };
    check(
        "links take the color of their bubble",
        link_colors.other === (await probe(page, "--color-link-message-bubble")) &&
            link_colors.own === (await probe(page, "--color-link-own-message-bubble")) &&
            link_colors.other !== link_colors.own,
        JSON.stringify(link_colors),
    );

    // A manually collapsed message is a dashed frame on its side.
    const collapsed = await page.$eval(row_selector(ids["collapsed"]!), (row) => {
        const controller = row.querySelector(".message_length_controller")!;
        return {
            border: getComputedStyle(controller).borderTopStyle,
            right: controller.getBoundingClientRect().right,
            content_background: getComputedStyle(row.querySelector(".message_content")!).backgroundColor,
            label: controller.textContent?.trim(),
        };
    });
    check(
        "a collapsed message is a dashed frame",
        collapsed.border === "dashed" &&
            Math.abs(collapsed.right - all["collapsed"]!.feed_right) < 2 &&
            collapsed.content_background === "rgba(0, 0, 0, 0)" &&
            collapsed.label === "Show more",
        JSON.stringify(collapsed),
    );

    await shot_all(page, ids, "light");

    // A long message is condensed, with "Show more" inside its bubble.
    const long_row = row_selector(ids["long"]!);
    const condensed = await page.$eval(long_row, (row) => {
        const bubble = row.querySelector(".message_content")!.getBoundingClientRect();
        const toggle = row.querySelector(".message_length_toggle")!.getBoundingClientRect();
        return {
            condensed: row.querySelector(".message_content")!.classList.contains("condensed"),
            inside:
                toggle.left > bubble.left &&
                toggle.right < bubble.right &&
                toggle.top > bubble.top &&
                toggle.bottom < bubble.bottom,
            label: row.querySelector(".message_length_toggle")!.textContent?.trim(),
        };
    });
    check(
        "a long message is condensed with Show more inside its bubble",
        condensed.condensed && condensed.inside && condensed.label === "Show more",
        JSON.stringify(condensed),
    );
    await page.click(`${long_row} .message_length_toggle`);
    await page.waitForSelector(`${long_row} .message_content:not(.condensed)`);
    const expanded = await page.$eval(long_row, (row) => {
        const bubble = row.querySelector(".message_content")!.getBoundingClientRect();
        const toggle = row.querySelector(".message_length_toggle")!.getBoundingClientRect();
        return {
            below: toggle.top >= bubble.bottom,
            label: row.querySelector(".message_length_toggle")!.textContent?.trim(),
        };
    });
    check(
        "an expanded long message has Show less under its bubble",
        expanded.below && expanded.label === "Show less",
        JSON.stringify(expanded),
    );
    await page.mouse.move(1, 1);
    await page.$eval(long_row, (row) => {
        row.scrollIntoView({block: "end"});
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await shot_list(page, "light-long-expanded");

    // A spoiler opens inside its bubble.
    const spoiler_row = row_selector(ids["spoiler"]!);
    await page.click(`${spoiler_row} .spoiler-header`);
    await page.waitForSelector(`${spoiler_row} .spoiler-content.spoiler-content-open`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const spoiler = await page.$eval(spoiler_row, (row) => ({
        height: row.querySelector(".spoiler-content")!.getBoundingClientRect().height,
        line: getComputedStyle(row.querySelector(".spoiler-content")!).borderTopStyle,
    }));
    check(
        "an opened spoiler shows its content under a line",
        spoiler.height > 10 && spoiler.line === "solid",
        JSON.stringify(spoiler),
    );
    await page.mouse.move(1, 1);
    await shot_row(page, ids["spoiler"]!, "light-spoiler-open");

    // Nothing overflows a narrow window either; wide content scrolls.
    await page.setViewport({width: 480, height: 1000});
    await open_view(page, conversation);
    await page.waitForSelector(`${row_selector(ids["poll"]!)} .widget-content`);
    const narrow_overflowing: string[] = [];
    for (const [name, id] of Object.entries(ids)) {
        if (name !== "bot" && (await facts(page, id)).overflows) {
            narrow_overflowing.push(name);
        }
    }
    check(
        "nothing overflows a narrow window",
        narrow_overflowing.length === 0,
        narrow_overflowing.join(", "),
    );
    await shot_row(page, ids["code"]!, "light-narrow-code");
    await shot_row(page, ids["table"]!, "light-narrow-table");
    await shot_row(page, ids["poll"]!, "light-narrow-poll");
    await page.setViewport({width: 1280, height: 1000});

    await set_setting(page, "color_scheme=2");
    await page.reload();
    await open_view(page, conversation);
    await page.waitForSelector(`${row_selector(ids["poll"]!)} .widget-content`);
    await check_code_colors(page, ids, "rgb(22, 22, 22)");
    await shot_all(page, ids, "dark");

    // A bot's message has a "Bot" label next to its name.
    await open_view(page, `#narrow/dm/${seeded.welcome_bot}-Welcome-Bot`);
    const bot_row = row_selector(ids["bot"]!);
    const bot = await page.$eval(bot_row, (row) => ({
        label: row.querySelector(".message-sender-bot-label")!.textContent?.trim(),
        label_shown: getComputedStyle(row.querySelector(".message-sender-bot-label")!).display,
        icon_shown: getComputedStyle(row.querySelector(".zulip-icon-bot")!).display,
    }));
    check(
        "a bot's message has a Bot label instead of the icon",
        bot.label === "Bot" && bot.label_shown !== "none" && bot.icon_shown === "none",
        JSON.stringify(bot),
    );
    await shot_row(page, ids["bot"]!, "dark-bot");

    // The classic layout keeps the bot icon.
    await set_setting(page, "web_direct_message_bubbles=false");
    await page.waitForFunction(
        () => !document.querySelector(".focused-message-list")!.classList.contains("bubble-layout"),
    );
    const classic_bot = await page.$eval(bot_row, (row) => ({
        label_shown: getComputedStyle(row.querySelector(".message-sender-bot-label")!).display,
        icon_shown: getComputedStyle(row.querySelector(".zulip-icon-bot")!).display,
    }));
    check(
        "the classic layout keeps the bot icon",
        classic_bot.label_shown === "none" && classic_bot.icon_shown !== "none",
        JSON.stringify(classic_bot),
    );
    await set_setting(page, "web_direct_message_bubbles=true");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(content_test);
