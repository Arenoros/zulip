import {execSync} from "node:child_process";

import type {HTTPRequest, Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";

// Seeds a direct message conversation between Desdemona and Iago with
// fixed timestamps, including pauses longer than five minutes, a
// message from the day before, and unread messages starting in the
// middle of a series.
const seed_script = String.raw`import json
from datetime import datetime, timedelta, timezone

from django.db.models import F

from zerver.actions.message_send import internal_send_private_message
from zerver.models import Message, UserMessage
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
start = datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc)

plan = [
    (iago, 0, "Hi Desdemona, are you around?"),
    (iago, 1, "I have a question about the release."),
    (desdemona, 2, "Yes, go ahead."),
    (desdemona, 3, "I'm at my desk."),
    (
        iago,
        4,
        "The build on the staging server keeps failing at the same step, and I "
        "could not find anything useful in the logs. Could you take a look at it "
        "when you have a minute? It started after yesterday's merge, so it is "
        "probably related to the new dependency.",
    ),
    (iago, 8, "The logs are here: https://zulip.com/help/"),
    (iago, 15, "One more thing."),
    (desdemona, 20, "Sure"),
    (
        desdemona,
        26,
        "I looked at it: the new package needs a newer compiler than the one on "
        "staging. I will update the image and restart the build, it should be "
        "green again in about twenty minutes.",
    ),
    (desdemona, 27, "**Done**, see [the dashboard](https://zulip.com/)."),
    (iago, 28, "ok"),
    (iago, 40, "/me waves"),
    (iago, 41, "@**Desdemona** please check the dashboard"),
]

yesterday = internal_send_private_message(iago, desdemona, "A message from the day before.")
Message.objects.filter(id=yesterday).update(date_sent=start - timedelta(days=1))

ids = []
for sender, minutes, content in plan:
    recipient = iago if sender == desdemona else desdemona
    message_id = internal_send_private_message(sender, recipient, content)
    Message.objects.filter(id=message_id).update(date_sent=start + timedelta(minutes=minutes))
    ids.append(message_id)

UserMessage.objects.filter(
    user_profile=desdemona, message_id__in=[yesterday, *ids[:5]]
).update(flags=F("flags").bitor(UserMessage.flags.read))

print(
    "SEEDED "
    + json.dumps(
        {"ids": ids, "yesterday": yesterday, "iago": iago.id, "desdemona": desdemona.id}
    )
)
`;
const shot_prefix = process.env["SHOT_PREFIX"] ?? "bubbles";
// Only take the classic-layout screenshots, for comparing them with
// the same screenshots taken before the bubble layout existed.
const classic_only = process.env["CLASSIC_ONLY"] === "1";

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

async function shot_row(page: Page, message_id: number, name: string): Promise<void> {
    const selector = `.focused-message-list .message_row[data-message-id="${message_id}"]`;
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
    const status = await api(page, "PATCH", "/json/settings", body);
    if (status !== 200) {
        throw new Error(`PATCH /json/settings ${body}: ${status}`);
    }
}

type RowInfo = {
    id: number;
    own: boolean;
    includes_sender: boolean;
    avatar_visible: boolean;
    name_text: string;
    name_visible: boolean;
    bubble_left: number;
    bubble_right: number;
    bubble_width: number;
    row_left: number;
    row_right: number;
    time_visibility: string;
    background: string;
};

async function rows_info(page: Page): Promise<RowInfo[]> {
    return await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".focused-message-list .message_row")].map(
            (row) => {
                const bubble = row.querySelector(".message_content")!.getBoundingClientRect();
                const content_element = row.querySelector(".messagebox-content")!;
                const content = content_element.getBoundingClientRect();
                // Bubbles are laid out within the padding of the row.
                const padding_left = Number.parseFloat(
                    getComputedStyle(content_element).paddingLeft,
                );
                const avatar = row.querySelector(".message-avatar");
                const name = row.querySelector<HTMLElement>(".sender_name");
                const name_rect = name?.getBoundingClientRect();
                return {
                    id: Number(row.dataset["messageId"]),
                    own: row.classList.contains("own-message"),
                    includes_sender: row.classList.contains("messagebox-includes-sender"),
                    avatar_visible:
                        avatar !== null && avatar.getBoundingClientRect().width > 0,
                    name_text: name?.textContent?.trim() ?? "",
                    name_visible: name_rect !== undefined && name_rect.width > 2,
                    bubble_left: bubble.left,
                    bubble_right: bubble.right,
                    bubble_width: bubble.width,
                    row_left: content.left + padding_left,
                    row_right: content.right,
                    time_visibility: getComputedStyle(row.querySelector(".message-time")!)
                        .visibility,
                    background: getComputedStyle(row.querySelector(".message_content")!)
                        .backgroundColor,
                };
            },
        ),
    );
}

async function visual_test(page: Page): Promise<void> {
    // Seed before logging in, so that the web app fetches the messages
    // with their backdated timestamps instead of receiving them as events.
    const output = execSync("./manage.py shell", {encoding: "utf8", input: seed_script});
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as {
        ids: number[];
        yesterday: number;
        iago: number;
        desdemona: number;
    };
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    const can_hover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
    console.log(`hover: ${can_hover}`);
    const conversation = `#narrow/dm/${seeded.iago}-Iago`;

    // Viewing the conversation marks its messages as read, so check the
    // dividers first. Every run views it here, so the classic
    // screenshots below are always taken with the messages read.
    await open_view(page, conversation);
    const first_unread_id = seeded.ids[5]!;
    const divider_gap = async (): Promise<number> =>
        await page.evaluate((ids: number[]) => {
            function bubble(id: number): DOMRect {
                return document
                    .querySelector(
                        `.focused-message-list .message_row[data-message-id="${id}"] .message_content`,
                    )!
                    .getBoundingClientRect();
            }
            return bubble(ids[5]!).top - bubble(ids[4]!).bottom;
        }, seeded.ids);
    if (!classic_only) {
        const dividers = await page.evaluate(() => {
            const list = document.querySelector(".focused-message-list")!;
            return {
                headers_shown: [...list.querySelectorAll(".message_header")].filter(
                    (header) => header.getBoundingClientRect().height > 0,
                ).length,
                unread_markers_shown: [...list.querySelectorAll(".unread_marker")].filter(
                    (marker) => getComputedStyle(marker).display !== "none",
                ).length,
                new_messages: [...list.querySelectorAll(".new-messages-divider")].map((divider) => ({
                    id: Number(divider.closest<HTMLElement>(".message_row")!.dataset["messageId"]),
                    text: divider.textContent?.trim(),
                })),
                dates: [...list.querySelectorAll(".date-divider-content")].map((content) => {
                    const divider = content.closest(".message_feed_divider")!.getBoundingClientRect();
                    const label = content.getBoundingClientRect();
                    return {
                        id: Number(content.closest<HTMLElement>(".message_row")!.dataset["messageId"]),
                        text: content.textContent?.trim(),
                        off_center:
                            label.left + label.width / 2 - (divider.left + divider.width / 2),
                    };
                }),
            };
        });
        check("the recipient bar is hidden", dividers.headers_shown === 0, String(dividers.headers_shown));
        check(
            "unread markers are hidden",
            dividers.unread_markers_shown === 0,
            String(dividers.unread_markers_shown),
        );
        check(
            "a new messages divider stands before the first unread message",
            JSON.stringify(dividers.new_messages) ===
                JSON.stringify([{id: first_unread_id, text: "New messages"}]),
            JSON.stringify(dividers.new_messages),
        );
        check(
            "each day starts with a date divider",
            JSON.stringify(dividers.dates.map((date) => date.id)) ===
                JSON.stringify([seeded.yesterday, seeded.ids[0]]),
            JSON.stringify(dividers.dates),
        );
        check(
            "dates are centered",
            dividers.dates.every((date) => Math.abs(date.off_center) < 2),
            JSON.stringify(dividers.dates.map((date) => date.off_center)),
        );
        const series_with_divider = (await rows_info(page))
            .filter((row) => seeded.ids.includes(row.id))
            .map((row) => row.includes_sender);
        check(
            "the first unread message starts a series",
            JSON.stringify(series_with_divider) ===
                JSON.stringify([true, false, true, false, true, true, true, true, true, false, true, true, true]),
            JSON.stringify(series_with_divider),
        );
        await shot_list(page, "dividers");
    }
    const gap_while_unread = await divider_gap();
    // Headless pages don't get window focus, which the web app needs
    // before it marks visible messages as read.
    await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("scroll"));
    });
    await page.keyboard.press("End");
    await page.waitForFunction(
        (id: number) =>
            !document
                .querySelector(`.focused-message-list .message_row[data-message-id="${id}"]`)!
                .classList.contains("unread"),
        {polling: 200},
        first_unread_id,
    );
    if (!classic_only) {
        // Let the fade finish.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const divider_opacity = await page.$eval(
            ".focused-message-list .new-messages-divider",
            (divider) => getComputedStyle(divider).opacity,
        );
        check("the divider fades out once read", divider_opacity === "0", divider_opacity);
        const gap_after_reading = await divider_gap();
        check(
            "reading does not move the messages",
            gap_after_reading === gap_while_unread,
            `${gap_while_unread} ${gap_after_reading}`,
        );
    }

    // The classic layout in views that bubbles must not change.
    await set_setting(page, "web_direct_message_bubbles=false&color_scheme=3");
    await open_view(page, conversation);
    await shot_list(page, "classic-conversation");
    await set_setting(page, "web_direct_message_bubbles=true");
    await open_view(page, "#narrow/is/dm");
    await shot_list(page, "classic-dm-feed");
    const verona_id = await page.evaluate(() => zulip_test.get_stream_id("Verona"));
    await open_view(page, `#narrow/channel/${verona_id}-Verona`);
    await shot_list(page, "classic-channel");
    await open_view(page, `#narrow/dm/${seeded.iago}-Iago/has/link`);
    await shot_list(page, "classic-search");
    if (classic_only) {
        return;
    }

    await api(page, "POST", "/json/mark_all_as_read");
    // Let the read flags reach the web app.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await open_view(page, conversation);
    const has_class = await page.$eval(".focused-message-list", (list) =>
        list.classList.contains("bubble-layout"),
    );
    check("the conversation uses the bubble layout", has_class);

    const rows = (await rows_info(page)).filter((row) => seeded.ids.includes(row.id));
    check("all seeded messages are shown", rows.length === seeded.ids.length, String(rows.length));

    // The messages are read by now, so there is no new messages divider.
    const series_starts = rows.map((row) => row.includes_sender);
    check(
        "a pause of more than five minutes starts a new series",
        JSON.stringify(series_starts) ===
            JSON.stringify([true, false, true, false, true, false, true, true, true, false, true, true, true]),
        JSON.stringify(series_starts),
    );

    const gaps = await page.evaluate((ids: number[]) => {
        function rect(id: number, selector: string): DOMRect {
            return document
                .querySelector(`.focused-message-list .message_row[data-message-id="${id}"] ${selector}`)!
                .getBoundingClientRect();
        }
        const font_size = Number.parseFloat(
            getComputedStyle(document.querySelector(".focused-message-list .message_content")!)
                .fontSize,
        );
        return {
            font_size,
            within_series: rect(ids[1]!, ".message_content").top - rect(ids[0]!, ".message_content").bottom,
            between_series:
                rect(ids[6]!, ".message-sender-and-time").top - rect(ids[5]!, ".message_content").bottom,
        };
    }, seeded.ids);
    check(
        "bubbles in a series are 3px apart at 15px",
        Math.abs(gaps.within_series - (3 * gaps.font_size) / 15) < 1,
        JSON.stringify(gaps),
    );
    check(
        "series are 16px apart at 15px",
        Math.abs(gaps.between_series - (16 * gaps.font_size) / 15) < 1.5,
        JSON.stringify(gaps),
    );

    const own_rows = rows.filter((row) => row.own);
    const other_rows = rows.filter((row) => !row.own);
    check(
        "own messages end at the right edge",
        own_rows.every((row) => Math.abs(row.row_right - row.bubble_right) < 1.5),
        JSON.stringify(own_rows.map((row) => [row.bubble_right, row.row_right])),
    );
    check(
        "own messages leave 15% free on the left",
        own_rows.every((row) => row.bubble_left - row.row_left >= 0.15 * (row.row_right - row.row_left) - 1),
        JSON.stringify(own_rows.map((row) => [row.bubble_left, row.row_left, row.row_right])),
    );
    check(
        "messages from others start after the avatar",
        other_rows.every((row) => row.bubble_left - row.row_left > 30),
        JSON.stringify(other_rows.map((row) => row.bubble_left - row.row_left)),
    );
    check(
        "messages from others leave 15% free on the right",
        other_rows.every((row) => row.row_right - row.bubble_right >= 0.15 * (row.row_right - row.row_left) - 1),
        JSON.stringify(other_rows.map((row) => row.row_right - row.bubble_right)),
    );
    check(
        "short bubbles fit their text",
        rows.filter((row) => row.id === seeded.ids[7]).every((row) => row.bubble_width < 100),
        JSON.stringify(rows.filter((row) => row.id === seeded.ids[7]).map((row) => row.bubble_width)),
    );
    check(
        "own messages have no visible avatar or name",
        own_rows.every((row) => !row.avatar_visible && !row.name_visible),
    );
    check(
        "own names stay in the markup",
        own_rows
            .filter((row) => row.includes_sender)
            .every((row) => row.name_text === "Desdemona"),
        JSON.stringify(own_rows.map((row) => row.name_text)),
    );
    check(
        "series from others show the avatar and name",
        other_rows
            .filter((row) => row.includes_sender)
            .every((row) => row.avatar_visible && row.name_visible),
    );
    check(
        "own and other bubbles have different colors",
        own_rows[0]!.background !== other_rows[0]!.background,
        `${own_rows[0]!.background} ${other_rows[0]!.background}`,
    );
    check(
        "the time of a series start is visible",
        rows.filter((row) => row.includes_sender).every((row) => row.time_visibility === "visible"),
    );
    check(
        can_hover
            ? "the time of other messages is hidden"
            : "without hover, the time of every message is visible",
        rows
            .filter((row) => !row.includes_sender)
            .every((row) => row.time_visibility === (can_hover ? "hidden" : "visible")),
    );

    const second_id = seeded.ids[1]!;
    await page.hover(`.focused-message-list .message_row[data-message-id="${second_id}"] .message_content`);
    const hovered_visibility = await page.$eval(
        `.focused-message-list .message_row[data-message-id="${second_id}"] .message-time`,
        (time) => getComputedStyle(time).visibility,
    );
    check("hovering a message shows its time", hovered_visibility === "visible");
    await shot_list(page, "light-24h-hover");
    await page.mouse.move(1, 1);

    // Star, react to and edit messages, to see them in bubbles.
    await api(
        page,
        "POST",
        "/json/messages/flags",
        `messages=${JSON.stringify([seeded.ids[4], seeded.ids[8]])}&op=add&flag=starred`,
    );
    await api(page, "POST", `/json/messages/${seeded.ids[1]}/reactions`, "emoji_name=thumbs_up");
    await api(page, "POST", `/json/messages/${seeded.ids[3]}/reactions`, "emoji_name=heart");
    // Seeded messages are too old to edit, so send and edit a new one.
    const sent_id = await page.evaluate(async (iago) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')?.value ??
            "";
        const response = await fetch("/json/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-CSRFToken": csrf_token,
            },
            body: `type=direct&to=${JSON.stringify([iago])}&content=A message to edit`,
        });
        return ((await response.json()) as {id: number}).id;
    }, seeded.iago);
    await page.waitForSelector(`.focused-message-list .message_row[data-message-id="${sent_id}"]`);
    await api(page, "PATCH", `/json/messages/${sent_id}`, "content=An edited message");
    await page.waitForSelector(
        `.focused-message-list .message_row[data-message-id="${sent_id}"] .message_edit_notice`,
    );
    await shot_list(page, "light-24h");

    // Headless Chrome reports no hover-capable pointer, so every time
    // is shown. Hide them as a desktop browser would, for one screenshot.
    const desktop_style = await page.addStyleTag({
        content: `.message-list.bubble-layout .message_row:not(.messagebox-includes-sender) .messagebox-content:not(:hover) .message-time { visibility: hidden; }`,
    });
    await shot_list(page, "light-24h-desktop");
    await desktop_style.evaluate((style) => {
        style.remove();
    });

    // An uploaded image, from someone else and from oneself.
    const image_message_id = await page.evaluate(async (iago) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')?.value ??
            "";
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 450;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "hsl(200deg 60% 50%)";
        context.fillRect(0, 0, 800, 450);
        context.fillStyle = "hsl(40deg 90% 60%)";
        context.fillRect(100, 100, 300, 200);
        const blob = await new Promise<Blob>((resolve) => {
            canvas.toBlob((blob) => {
                resolve(blob!);
            }, "image/png");
        });
        const form = new FormData();
        form.append("file", blob, "screenshot.png");
        const upload = await fetch("/json/user_uploads", {
            method: "POST",
            headers: {"X-CSRFToken": csrf_token},
            body: form,
        });
        const {url} = (await upload.json()) as {url: string};
        const response = await fetch("/json/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-CSRFToken": csrf_token,
            },
            body: `type=direct&to=${JSON.stringify([iago])}&content=${encodeURIComponent(`[screenshot.png](${url})`)}`,
        });
        return ((await response.json()) as {id: number}).id;
    }, seeded.iago);
    await page.waitForSelector(
        `.focused-message-list .message_row[data-message-id="${image_message_id}"] .message_content img`,
    );
    await shot_row(page, image_message_id, "image");
    await shot_row(page, seeded.ids[11]!, "me-message");
    await shot_row(page, seeded.ids[12]!, "mention");

    // Message states.
    const row_selector = (id: number): string =>
        `.focused-message-list .message_row[data-message-id="${id}"]`;

    // Selection with the keyboard: a ring around the bubble, time shown.
    await page.click(`${row_selector(seeded.ids[1]!)} .message_content`);
    await page.mouse.move(1, 1);
    const selection = await page.$eval(row_selector(seeded.ids[1]!), (row) => ({
        selected: row.classList.contains("selected_message"),
        row_outline: getComputedStyle(row.querySelector(".messagebox-content")!).outlineStyle,
        bubble_outline: getComputedStyle(row.querySelector(".message_content")!).outlineWidth,
        time: getComputedStyle(row.querySelector(".message-time")!).visibility,
    }));
    check(
        "the selected message has a ring around its bubble",
        selection.selected &&
            selection.row_outline === "none" &&
            selection.bubble_outline === "2px" &&
            selection.time === "visible",
        JSON.stringify(selection),
    );
    await shot_row(page, seeded.ids[1]!, "selected");

    // The hover controls float over the top edge of the bubble.
    for (const id of [seeded.ids[1]!, seeded.ids[3]!]) {
        await page.hover(`${row_selector(id)} .message_content`);
        const panel = await page.$eval(row_selector(id), (row) => {
            const controls = row.querySelector(".message_controls")!;
            const bubble = row.querySelector(".message_content")!.getBoundingClientRect();
            const rect = controls.getBoundingClientRect();
            return {
                position: getComputedStyle(controls).position,
                buttons: [...controls.querySelectorAll(".message_control_button")].filter(
                    (button) => button.getBoundingClientRect().width > 0,
                ).length,
                above_top: rect.top < bubble.top && rect.bottom > bubble.top,
                beside:
                    Math.abs(rect.left - bubble.right) < 30 ||
                    Math.abs(rect.right - bubble.left) < 30,
            };
        });
        check(
            `the hover controls float at the top edge of message ${id}`,
            panel.position === "absolute" && panel.buttons >= 3 && panel.above_top && panel.beside,
            JSON.stringify(panel),
        );
        await shot_row(page, id, `hover-controls-${id === seeded.ids[1] ? "other" : "own"}`);
    }
    await page.mouse.move(1, 1);

    // Editing in place uses 85% of the feed.
    await page.evaluate(() => {
        zulip_test.cancel_compose();
    });
    await page.hover(`${row_selector(sent_id)} .message_content`);
    await page.click(`${row_selector(sent_id)} .edit_content_button`);
    await page.waitForSelector(`${row_selector(sent_id)} .message_edit`, {visible: true});
    const editor = await page.$eval(row_selector(sent_id), (row) => {
        const content = row.querySelector(".messagebox-content")!;
        const padding = Number.parseFloat(getComputedStyle(content).paddingLeft);
        const width = content.getBoundingClientRect().width - padding;
        return row.querySelector(".message_edit")!.getBoundingClientRect().width / width;
    });
    check("the editor takes 85% of the feed", Math.abs(editor - 0.85) < 0.02, String(editor));
    await shot_row(page, sent_id, "editing");
    await page.keyboard.press("Escape");
    await page.waitForSelector(`${row_selector(sent_id)} .message_edit`, {hidden: true});

    // A message being sent, then failing to send.
    await page.setRequestInterception(true);
    let held: HTTPRequest | undefined;
    const hold_sends = (request: HTTPRequest): void => {
        if (request.method() === "POST" && request.url().endsWith("/json/messages")) {
            held = request;
            return;
        }
        void request.continue();
    };
    page.on("request", hold_sends);
    await page.click("#left_bar_compose_reply_button_big");
    await page.waitForSelector("#compose-textarea", {visible: true});
    await page.type("#compose-textarea", "A message that will not go through");
    await page.click("#compose-send-button");
    await page.waitForSelector(".focused-message-list .message_row.locally-echoed");
    await page.evaluate(() => {
        zulip_test.cancel_compose();
    });
    await page.mouse.move(1, 1);
    const echo = await page.$eval(".focused-message-list .message_row.locally-echoed", (row) => ({
        notice: getComputedStyle(row.querySelector(".message-sending-notice")!).display,
        text: row.querySelector(".message-sending-notice")!.textContent?.trim(),
        opacity: getComputedStyle(row.querySelector(".message_content")!).opacity,
        time: getComputedStyle(row.querySelector(".message-time")!).display,
    }));
    check(
        "a message being sent is faded and says Sending",
        echo.notice !== "none" && echo.text === "Sending…" && echo.opacity === "0.6" && echo.time === "none",
        JSON.stringify(echo),
    );
    const echo_id = await page.$eval(".focused-message-list .message_row.locally-echoed", (row) =>
        Number.parseFloat(row.getAttribute("data-message-id")!),
    );
    await shot_row(page, echo_id, "sending");

    await held!.abort("failed");
    await page.waitForSelector(".focused-message-list .message_row .failed_message_action");
    const failure = await page.$eval(".focused-message-list .message_row.locally-echoed", (row) => ({
        notice: row.querySelector(".failed-message-notice")!.textContent?.trim(),
        notice_shown: getComputedStyle(row.querySelector(".failed-message-notice")!).display,
        labels: [...row.querySelectorAll(".failed-message-action-label")].map(
            (label) => getComputedStyle(label).display !== "none" && label.textContent?.trim(),
        ),
        border: getComputedStyle(row.querySelector(".message_content")!).borderTopColor,
        sending_shown: getComputedStyle(row.querySelector(".message-sending-notice")!).display,
    }));
    check(
        "a failed message says Not sent, with Retry and Delete",
        failure.notice === "Not sent." &&
            failure.notice_shown !== "none" &&
            JSON.stringify(failure.labels) === JSON.stringify(["Retry", "Delete"]) &&
            failure.sending_shown === "none",
        JSON.stringify(failure),
    );
    await shot_row(page, echo_id, "failed");

    page.off("request", hold_sends);
    await page.setRequestInterception(false);
    await page.click(".focused-message-list .message_row .refresh-failed-message");
    await page.waitForFunction(
        () => document.querySelectorAll(".focused-message-list .message_row.locally-echoed").length === 0,
    );
    check("retrying sends the message", true);

    // A reminder under a message.
    const reminder_status = await api(
        page,
        "POST",
        "/json/reminders",
        `message_id=${seeded.ids[1]}&scheduled_delivery_timestamp=${Math.floor(Date.now() / 1000) + 3600}&note=Check the logs`,
    );
    check("a reminder can be set", reminder_status === 200, String(reminder_status));
    await page.waitForSelector(`${row_selector(seeded.ids[1]!)} .message-reminders`);
    await shot_row(page, seeded.ids[1]!, "reminder");

    // A muted sender keeps the layout.
    await api(page, "POST", `/json/users/me/muted_users/${seeded.iago}`);
    await page.waitForSelector(`${row_selector(seeded.ids[1]!)}.muted-message-sender`);
    const muted_overflow = await page.evaluate(
        () =>
            [...document.querySelectorAll(".focused-message-list .messagebox-content")].filter(
                (content) => content.scrollWidth > content.clientWidth + 1,
            ).length,
    );
    check("muted messages do not overflow", muted_overflow === 0, String(muted_overflow));
    await shot_row(page, seeded.ids[1]!, "muted");
    await api(page, "DELETE", `/json/users/me/muted_users/${seeded.iago}`);
    await page.waitForFunction(
        (selector: string) => !document.querySelector(selector)!.classList.contains("muted-message-sender"),
        {},
        row_selector(seeded.ids[1]!),
    );
    await shot_list(page, "states-light");

    await set_setting(page, "color_scheme=2&twenty_four_hour_time=false&web_font_size_px=17&web_line_height_percent=150");
    await page.reload();
    await open_view(page, conversation);
    await shot_list(page, "dark-12h-17px");

    await set_setting(page, "color_scheme=3&twenty_four_hour_time=true&web_font_size_px=15&web_line_height_percent=140");
    await page.setViewport({width: 480, height: 900});
    await page.reload();
    await open_view(page, conversation);
    const narrow_rows = (await rows_info(page)).filter((row) => seeded.ids.includes(row.id));
    const narrow_own = narrow_rows.filter((row) => row.own);
    check(
        "narrow windows leave 12% free",
        narrow_own.every((row) => {
            const free = (row.bubble_left - row.row_left) / (row.row_right - row.row_left);
            return free >= 0.115 && (row.bubble_width < 300 || free < 0.14);
        }),
        JSON.stringify(narrow_own.map((row) => (row.bubble_left - row.row_left) / (row.row_right - row.row_left))),
    );
    const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll(".focused-message-list .messagebox-content")].filter(
            (content) => content.scrollWidth > content.clientWidth + 1,
        ).length,
    );
    check("nothing overflows in a narrow window", overflowing === 0, String(overflowing));
    await shot_list(page, "narrow-480");

    // Turning the setting off switches back without a reload.
    await page.setViewport({width: 1280, height: 1000});
    await open_view(page, conversation);
    await set_setting(page, "web_direct_message_bubbles=false");
    await page.waitForFunction(
        () => !document.querySelector(".focused-message-list")!.classList.contains("bubble-layout"),
    );
    const classic_rows = (await rows_info(page)).filter((row) => seeded.ids.includes(row.id));
    check(
        "turning the setting off restores the classic series",
        JSON.stringify(classic_rows.map((row) => row.includes_sender)) ===
            JSON.stringify([true, false, true, false, true, false, false, true, false, false, true, true, true]),
        JSON.stringify(classic_rows.map((row) => row.includes_sender)),
    );
    await set_setting(page, "web_direct_message_bubbles=true");
    await page.waitForFunction(() =>
        document.querySelector(".focused-message-list")!.classList.contains("bubble-layout"),
    );
    check("turning the setting on again shows bubbles without a reload", true);

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
