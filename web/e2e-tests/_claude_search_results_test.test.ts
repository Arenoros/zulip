import type {HTTPRequest, Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "search-results";
const keyword = "zebraresult";

type RawMessage = {
    id: number;
    type: string;
    content: string;
    subject: string;
};

async function api(page: Page, method: string, url: string, body?: string): Promise<unknown> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const [status, data] = await page.evaluate(
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
                ...(body !== undefined && {body}),
            });
            return [response.status, (await response.json()) as unknown];
        },
        method,
        url,
        body,
    );
    if (status !== 200) {
        throw new Error(`${method} ${url} ${body}: ${status}`);
    }
    return data;
}

async function send(page: Page, body: Record<string, string>): Promise<number> {
    const data = (await api(
        page,
        "POST",
        "/json/messages",
        new URLSearchParams(body).toString(),
    )) as {id: number};
    return data.id;
}

// The test server doesn't index messages for keyword search, so the
// search results come from the messages sent here, marked up the way
// the server marks up matches.
async function serve_search_results(page: Page, messages: RawMessage[]): Promise<void> {
    const highlight = (text: string): string =>
        text.replaceAll(keyword, `<span class="highlight">${keyword}</span>`);
    page.removeAllListeners("request");
    await page.setRequestInterception(true);
    page.on("request", (request: HTTPRequest) => {
        if (request.isInterceptResolutionHandled()) {
            return;
        }
        const url = new URL(request.url());
        const narrow = url.searchParams.get("narrow") ?? "";
        if (url.pathname !== "/json/messages" || !narrow.includes('"search"')) {
            void request.continue();
            return;
        }
        const terms = JSON.parse(narrow) as {operator: string; operand: string}[];
        const search = terms.find((term) => term.operator === "search")!.operand;
        const only_direct = terms.some((term) => term.operator === "is" && term.operand === "dm");
        const found = (search === keyword ? messages : [])
            .filter((message) => !only_direct || message.type === "private")
            .map((message) => ({
                ...message,
                match_content: highlight(message.content),
                match_subject: highlight(message.subject),
            }));
        void request.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                result: "success",
                msg: "",
                anchor: found.at(-1)?.id ?? 0,
                found_newest: true,
                found_oldest: true,
                found_anchor: false,
                history_limited: false,
                messages: found,
            }),
        });
    });
}

async function open(page: Page, hash: string, wait_for: string): Promise<void> {
    const url = `${base_url}${hash}`;
    const is_same_url = page.url() === url;
    await page.goto(url);
    if (is_same_url) {
        // Going to the same URL doesn't open the view again.
        await page.reload();
    }
    await page.waitForSelector(wait_for, {visible: true});
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
}

type Results = {
    links: {label: string; href: string; message_id: string}[];
    notices: string[];
};

async function search_results(page: Page): Promise<Results> {
    return await page.evaluate(() => {
        const links = [
            ...document.querySelectorAll<HTMLAnchorElement>(
                ".focused-message-list .conversation-fragment-open",
            ),
        ];
        return {
            links: links.map((link) => ({
                label: link.textContent.trim(),
                href: link.getAttribute("href") ?? "",
                message_id:
                    link.closest(".recipient_row")?.querySelector(".message_row")?.getAttribute("data-message-id") ??
                    "",
            })),
            notices: [
                ".search-end-of-results-notice",
                ".all-messages-search-caution",
                ".empty_feed_notice",
            ].filter((selector) => document.querySelector(selector)?.checkVisibility() ?? false),
        };
    });
}

async function selected_after_click(
    page: Page,
    index: number,
): Promise<{hash: string; selected: string | undefined}> {
    await page.evaluate((index: number) => {
        document
            .querySelectorAll<HTMLAnchorElement>(".focused-message-list .conversation-fragment-open")
            [index]!.click();
    }, index);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return await page.evaluate(() => ({
        hash: window.location.hash,
        selected:
            document.querySelector(".focused-message-list .selected_message")?.getAttribute("data-message-id") ??
            undefined,
    }));
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function highlight_colors(page: Page): Promise<{text: string[]; topic: string[]}> {
    return await page.evaluate(() => {
        const style = (element: Element | null): string[] =>
            element === null
                ? []
                : [getComputedStyle(element).backgroundColor, getComputedStyle(element).color];
        return {
            text: style(document.querySelector(".focused-message-list .message_content .highlight")),
            topic: style(document.querySelector(".focused-message-list .message_header .highlight")),
        };
    });
}

async function search_results_test(page: Page): Promise<void> {
    await page.setViewport({width: 1280, height: 900});
    await common.log_in(page);
    await api(page, "PATCH", "/json/settings", "color_scheme=3&web_font_size_px=15");

    const cordelia = await common.get_user_id_from_name(page, "Cordelia, Lear's daughter");
    const hamlet = await common.get_user_id_from_name(page, "King Hamlet");
    const channel_id = await send(page, {
        type: "stream",
        to: "Verona",
        topic: `${keyword} topic`,
        content: `A ${keyword} in a channel`,
    });
    const direct_id = await send(page, {
        type: "direct",
        to: JSON.stringify([cordelia]),
        content: `A ${keyword} in a direct message`,
    });
    const group_id = await send(page, {
        type: "direct",
        to: JSON.stringify([cordelia, hamlet]),
        content: `A ${keyword} in a group`,
    });
    const query = new URLSearchParams({
        anchor: "newest",
        num_before: "20",
        num_after: "0",
        client_gravatar: "true",
        apply_markdown: "true",
    }).toString();
    const all_messages = ((await api(page, "GET", `/json/messages?${query}`)) as {
        messages: RawMessage[];
    }).messages;
    const sent = all_messages.filter((message) =>
        [channel_id, direct_id, group_id].includes(message.id),
    );
    await serve_search_results(page, sent);

    // Direct messages: each result links to itself in its chat, and
    // the end of the results shows above them.
    await open(page, `#narrow/search/${keyword}/is/dm`, ".focused-message-list .message_row");
    const direct = await search_results(page);
    check(
        "direct message results link to their message in the chat",
        direct.links.length === 2 &&
            direct.links.every(
                (link) =>
                    link.label === "Show in chat" &&
                    link.href.includes("#narrow/dm/") &&
                    link.href.endsWith(`/near/${link.message_id}`),
            ),
        JSON.stringify(direct.links),
    );
    const notice_on_top = await page.evaluate(() => {
        const notice = document.querySelector(".search-end-of-results-notice")!;
        const first = document.querySelector(".focused-message-list .message_row")!;
        return {
            text: notice.textContent.trim(),
            above: notice.getBoundingClientRect().bottom <= first.getBoundingClientRect().top,
        };
    });
    check(
        "No more results shows above the first result, alone",
        JSON.stringify(direct.notices) === JSON.stringify([".search-end-of-results-notice"]) &&
            notice_on_top.text === "No more results" &&
            notice_on_top.above,
        JSON.stringify({notices: direct.notices, notice_on_top}),
    );
    const light = await highlight_colors(page);
    check(
        "light theme: matches are highlighted in #ffe58a",
        light.text[0] === "rgb(255, 229, 138)",
        JSON.stringify(light),
    );
    await shot(page, "direct");
    const chat = await selected_after_click(page, 1);
    check(
        "Show in chat opens the chat at the message",
        chat.hash.startsWith("#narrow/dm/") &&
            chat.hash.endsWith(`/near/${direct.links[1]!.message_id}`) &&
            chat.selected === direct.links[1]!.message_id,
        JSON.stringify(chat),
    );

    // All results: Zulip's notice about searching shared history stays.
    await open(page, `#narrow/search/${keyword}`, ".focused-message-list .message_row");
    const all = await search_results(page);
    const channel_link = all.links.find((link) => link.message_id === String(channel_id));
    check(
        "a channel result links to its message in the conversation, next to chat results",
        JSON.stringify(all.links.map((link) => link.label).toSorted()) ===
            JSON.stringify(["Show in chat", "Show in chat", "Show in conversation"]) &&
            channel_link?.label === "Show in conversation" &&
            channel_link.href.includes("/topic/") &&
            channel_link.href.endsWith(`/near/${channel_id}`),
        JSON.stringify(all.links),
    );
    check(
        "where Zulip offers to search shared history, only its notice shows",
        JSON.stringify(all.notices) === JSON.stringify([".all-messages-search-caution"]),
        JSON.stringify(all.notices),
    );
    await shot(page, "all");
    const conversation = await selected_after_click(page, all.links.indexOf(channel_link!));
    check(
        "Show in conversation opens the topic at the message",
        conversation.hash.includes("/topic/") && conversation.selected === String(channel_id),
        JSON.stringify(conversation),
    );

    // Other mixed views keep Open conversation and Open chat.
    await open(page, "#narrow/is/dm", ".focused-message-list .message_row");
    const dm_feed = await search_results(page);
    check(
        "other mixed views keep Open chat, without the end of results",
        dm_feed.links.length > 0 &&
            dm_feed.links.every((link) => link.label === "Open chat") &&
            !dm_feed.notices.includes(".search-end-of-results-notice"),
        JSON.stringify(dm_feed),
    );

    // An empty search keeps Zulip's notice.
    await open(page, "#narrow/search/nothingmatches", ".empty_feed_notice");
    const empty = await search_results(page);
    check(
        "an empty search shows only Zulip's notice",
        JSON.stringify(empty.notices) === JSON.stringify([".empty_feed_notice"]),
        JSON.stringify(empty.notices),
    );

    // Dark theme.
    await api(page, "PATCH", "/json/settings", "color_scheme=2");
    await page.reload();
    await open(page, `#narrow/search/${keyword}`, ".focused-message-list .message_row");
    const dark = await highlight_colors(page);
    check(
        "dark theme: matches are #6b5a1a with light text, in messages and topics",
        JSON.stringify(dark.text) === JSON.stringify(["rgb(107, 90, 26)", "rgb(255, 243, 196)"]) &&
            JSON.stringify(dark.topic) ===
                JSON.stringify(["rgb(107, 90, 26)", "rgb(153, 221, 255)"]),
        JSON.stringify(dark),
    );
    await shot(page, "dark");

    // Russian.
    await api(page, "PATCH", "/json/settings", "default_language=ru&color_scheme=3");
    await page.reload();
    await open(page, `#narrow/search/${keyword}/is/dm`, ".focused-message-list .message_row");
    const ru_direct = await search_results(page);
    const ru_notice = await page.$eval(".search-end-of-results-notice", (notice) =>
        notice.textContent.trim(),
    );
    await open(page, `#narrow/search/${keyword}`, ".focused-message-list .message_row");
    const ru_all = await search_results(page);
    check(
        "in Russian: Показать в чате, Показать в беседе, Больше результатов нет",
        ru_direct.links.every((link) => link.label === "Показать в чате") &&
            ru_all.links.some((link) => link.label === "Показать в беседе") &&
            ru_notice === "Больше результатов нет",
        JSON.stringify({ru_direct: ru_direct.links, ru_all: ru_all.links, ru_notice}),
    );
    await shot(page, "ru");

    page.removeAllListeners("request");
    await page.setRequestInterception(false);
    await api(page, "PATCH", "/json/settings", "default_language=en&color_scheme=1");
    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(search_results_test);
