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
const shot_prefix = process.env["SHOT_PREFIX"] ?? "conversations";

// Seeds a channel with more topics than one page of topic cards, in
// a known order of activity, including a topic with hidden replies, a
// resolved topic, a long first message, messages without a topic, and
// a topic muted by Desdemona; and an empty channel.
const seed_script = String.raw`import json
from datetime import datetime, timedelta, timezone

from zerver.actions.message_send import internal_send_stream_message
from zerver.actions.streams import bulk_add_subscriptions
from zerver.actions.user_topics import do_set_user_topic_visibility_policy
from zerver.lib.streams import create_stream_if_needed
from zerver.models import Message, UserTopic
from zerver.models.realms import get_realm
from zerver.models.users import get_user_by_delivery_email

realm = get_realm("zulip")
desdemona = get_user_by_delivery_email("desdemona@zulip.com", realm)
iago = get_user_by_delivery_email("iago@zulip.com", realm)
hamlet = get_user_by_delivery_email("hamlet@zulip.com", realm)
othello = get_user_by_delivery_email("othello@zulip.com", realm)
cordelia = get_user_by_delivery_email("cordelia@zulip.com", realm)
users = [desdemona, iago, hamlet, othello, cordelia]

stream, _ = create_stream_if_needed(
    realm, "planning", stream_description="Release planning", acting_user=None
)
quiet, _ = create_stream_if_needed(realm, "quiet", acting_user=None)
bulk_add_subscriptions(realm, [stream, quiet], users, acting_user=None)

start = datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
minutes = 0


def send(sender, topic, content):
    global minutes
    minutes += 7
    message_id = internal_send_stream_message(sender, stream, topic, content)
    Message.objects.filter(id=message_id).update(date_sent=start + timedelta(minutes=minutes))
    return message_id


ids = {}
# The oldest topics, one message each, least recently active first.
for i in range(1, 23):
    ids[f"topic {i:02}"] = [send(hamlet, f"topic {i:02}", f"Status update number {i}.")]
ids["general chat"] = [send(iago, "", "A message without a topic.")]
ids["muted"] = [send(hamlet, "muted one", "Nobody wants to read this.")]
long_text = "\n\n".join(f"Paragraph {i} of a long first message." for i in range(1, 16))
ids["long"] = [send(othello, "long first message", long_text), send(iago, "long first message", "Short reply.")]
ids["resolved"] = [send(iago, "✔ deployed", "The build is out."), send(hamlet, "✔ deployed", "Thanks!")]
ids["talk"] = [send(desdemona, "release talk", "When do we ship?")]
for sender, content in [
    (iago, "Friday."),
    (hamlet, "Can we make it Thursday?"),
    (othello, "Thursday works for me."),
    (cordelia, "Then Thursday."),
    (iago, "I will prepare the notes."),
    (hamlet, "Great."),
    (othello, "See you then."),
]:
    ids["talk"].append(send(sender, "release talk", content))

do_set_user_topic_visibility_policy(
    desdemona, stream, "muted one", visibility_policy=UserTopic.VisibilityPolicy.MUTED
)

print(
    "SEEDED "
    + json.dumps({"ids": ids, "stream_id": stream.id, "quiet_id": quiet.id})
)
`;

type Seeded = {ids: Record<string, number[]>; stream_id: number; quiet_id: number};

async function set_setting(page: Page, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(async (body) => {
        const csrf_token =
            document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                ?.value ?? "";
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
        throw new Error(`PATCH /json/settings ${body}: ${status}`);
    }
}

type CardInfo = {
    title: string;
    resolved: boolean;
    empty_topic: boolean;
    hidden_replies: string;
    senders: string[];
    rows: number;
    times: string[];
    footer: boolean;
};

async function cards_info(page: Page): Promise<CardInfo[]> {
    return await page.evaluate(() =>
        [...document.querySelectorAll(".focused-message-list .recipient_row")].map((card) => ({
            title: card.querySelector(".topic-card-title-text")?.textContent.trim() ?? "",
            resolved: card.querySelector(".topic-card-resolved-label") !== null,
            empty_topic: card.querySelector(".topic-card-title-text.empty-topic-display") !== null,
            hidden_replies:
                card.querySelector(".topic-card-hidden-replies")?.textContent.trim() ?? "",
            senders: [...card.querySelectorAll(".message_row")].map(
                (row) => row.querySelector(".sender_name_text")?.textContent.trim() ?? "",
            ),
            rows: card.querySelectorAll(".message_row").length,
            times: [...card.querySelectorAll(".message-time")].map((time) =>
                time.textContent.trim(),
            ),
            footer: card.querySelector(".topic-card-reply-button") !== null,
        })),
    );
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await page.evaluate(() => {
        const list = document.querySelector(".focused-message-list")!.getBoundingClientRect();
        return {
            x: list.left + window.scrollX,
            y: window.scrollY,
            width: list.width,
            height: Math.min(list.bottom, window.innerHeight),
        };
    });
    await page.screenshot({
        path: `var/puppeteer/${shot_prefix}-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function open_conversations(page: Page, stream_id: number): Promise<void> {
    await page.goto(`${base_url}#conversations/channel/${stream_id}`);
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await page.mouse.move(1, 1);
}

async function conversations_view_test(page: Page): Promise<void> {
    // Seed before logging in, so that the web app fetches the messages
    // with their backdated timestamps.
    const output = execSync("./manage.py shell", {encoding: "utf8", input: seed_script});
    const seeded = JSON.parse(output.split("SEEDED ")[1]!) as Seeded;
    await fetch(`${base_url}flush_caches`, {method: "POST"});
    await page.emulateTimezone("UTC");
    await page.setViewport({width: 1280, height: 1000});
    await common.log_in(page);
    await set_setting(
        page,
        "web_channel_default_view=5&color_scheme=3&twenty_four_hour_time=true&web_font_size_px=15&web_line_height_percent=140",
    );
    await page.reload();
    await page.waitForSelector("#left-sidebar-navigation-list", {visible: true});

    // Clicking the channel opens its conversations.
    await page.click(`#left-sidebar .narrow-filter[data-stream-id="${seeded.stream_id}"] .stream-name`);
    await page.waitForSelector(".focused-message-list.conversations-view .recipient_row", {
        visible: true,
    });
    await page.mouse.move(1, 1);
    const url = page.url();
    check(
        "clicking the channel opens its conversations",
        url.includes(`#conversations/channel/${seeded.stream_id}`),
        url,
    );

    const header = await page.$eval("#message_view_header", (header) => ({
        icon: header.querySelector(".conversation-header-channel-icon .zulip-icon-hashtag") !== null,
        icon_color: getComputedStyle(header.querySelector(".conversation-header-channel-icon")!)
            .backgroundColor,
        title: header.querySelector(".message-header-navbar-title")?.textContent.trim(),
        subtitle: header.querySelector(".conversation-header-subtitle")?.textContent.trim(),
        settings_link: header
            .querySelector(".message-header-stream-settings-button")
            ?.getAttribute("href"),
    }));
    check(
        "the header shows the channel square with its icon, name and description, linking to its settings",
        header.icon &&
            header.title === "planning" &&
            header.subtitle === "Release planning" &&
            header.settings_link === `#channels/${seeded.stream_id}/planning/general`,
        JSON.stringify(header),
    );

    // The first page: the most recently active topics, newest at the bottom.
    let cards = await cards_info(page);
    const titles = cards.map((card) => card.title);
    check(
        "the latest topics come first in a page, the newest at the bottom",
        JSON.stringify(titles.slice(-5)) ===
            JSON.stringify([
                "topic 22",
                "general chat",
                "long first message",
                "deployed",
                "release talk",
            ]),
        JSON.stringify(titles.slice(-6)),
    );
    check("a muted topic has no card", !titles.includes("muted one"), JSON.stringify(titles));
    check(
        "one page holds 20 topics, less the muted one",
        cards.length === 19,
        String(cards.length),
    );
    const at_bottom = await page.evaluate(
        () =>
            document.documentElement.scrollHeight -
                document.documentElement.scrollTop -
                window.innerHeight <
            300,
    );
    check("the view opens at the newest topic", at_bottom);

    const talk = cards.find((card) => card.title === "release talk")!;
    check(
        "a card shows its first message and the three latest replies",
        talk.rows === 4 &&
            JSON.stringify(talk.senders) ===
                JSON.stringify([
                    "Desdemona",
                    "Iago",
                    "King Hamlet",
                    "Othello, the Moor of Venice",
                ]),
        JSON.stringify(talk.senders),
    );
    check(
        "the replies left out are summarized with their authors",
        talk.hidden_replies === "Open 4 replies from Cordelia, Lear's daughter, Othello, the Moor of Venice, and 2 others",
        talk.hidden_replies,
    );
    check("the card ends with a reply button", talk.footer);
    check(
        "every message shows its date and time",
        talk.times.every((time) => / at \d{2}:\d{2}$/.test(time)),
        JSON.stringify(talk.times),
    );

    const resolved = cards.find((card) => card.title === "deployed");
    check(
        "a resolved topic is titled without the check mark, with a label",
        resolved !== undefined && resolved.resolved,
        JSON.stringify(resolved),
    );
    const general_chat = cards.find((card) => card.empty_topic);
    check(
        "messages without a topic share one card",
        general_chat !== undefined && general_chat.title === "general chat",
        JSON.stringify(general_chat),
    );

    const long_first = await page.evaluate(() => {
        const title = [...document.querySelectorAll(".topic-card-title-text")].find(
            (element) => element.textContent.trim() === "long first message",
        )!;
        const content = title.closest(".message_row")!.querySelector(".message_content")!;
        const style = getComputedStyle(content);
        // The cut applies to the text, inside the content's padding.
        return {
            condensed: content.classList.contains("condensed"),
            height:
                content.getBoundingClientRect().height -
                Number.parseFloat(style.paddingTop) -
                Number.parseFloat(style.paddingBottom),
        };
    });
    check(
        "a long first message is cut at 168px",
        long_first.condensed && Math.abs(long_first.height - 168) <= 2,
        JSON.stringify(long_first),
    );
    await shot(page, "light-bottom");

    // Scrolling up loads older topics.
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    });
    await page.waitForFunction(
        () => document.querySelectorAll(".focused-message-list .recipient_row").length > 19,
    );
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    cards = await cards_info(page);
    check(
        "scrolling up loads older topics, the oldest at the top",
        cards.length === 26 && cards[0]!.title === "topic 01",
        `${cards.length} ${cards[0]?.title}`,
    );
    await shot(page, "light-top");

    // An empty channel.
    await page.goto(`${base_url}#conversations/channel/${seeded.quiet_id}`);
    await page.waitForSelector(".empty_feed_notice_main", {visible: true});
    const empty_text = await page.$eval(".empty_feed_notice_main", (notice) =>
        notice.textContent.trim(),
    );
    check(
        "an empty channel says it has no conversations yet",
        empty_text.startsWith("There are no conversations in this channel yet."),
        empty_text,
    );

    // Dark theme and a narrow window.
    await set_setting(page, "color_scheme=2");
    await page.reload();
    await open_conversations(page, seeded.stream_id);
    await shot(page, "dark-bottom");
    await page.setViewport({width: 480, height: 900});
    await page.reload();
    await open_conversations(page, seeded.stream_id);
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check("nothing overflows a 480px window", !overflow);
    await shot(page, "dark-narrow");
    await page.setViewport({width: 1280, height: 1000});

    // Other values of the setting keep the channel feed.
    await set_setting(page, "web_channel_default_view=2&color_scheme=3");
    await page.reload();
    await page.waitForSelector(`#left-sidebar .narrow-filter[data-stream-id="${seeded.stream_id}"] .stream-name`, {
        visible: true,
    });
    await page.click(`#left-sidebar .narrow-filter[data-stream-id="${seeded.stream_id}"] .stream-name`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    const feed = await page.evaluate(() => ({
        url: window.location.hash,
        conversations: document.querySelector(".focused-message-list.conversations-view") !== null,
    }));
    check(
        "with the channel feed setting, the channel opens its feed",
        feed.url.startsWith("#narrow/channel/") && !feed.conversations,
        JSON.stringify(feed),
    );

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(conversations_view_test);
