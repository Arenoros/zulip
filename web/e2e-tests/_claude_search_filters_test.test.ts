import type {HTTPRequest, Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "search-filters";
const keyword = "zebrafilter";

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

type Bar = {
    labels: string[];
    active: string[];
    current: string[];
    nav_label: string | null;
    hash: string;
};

async function bar(page: Page): Promise<Bar | undefined> {
    return await page.evaluate(() => {
        const nav = document.querySelector("#search-filters-container .search-filters");
        if (nav === null || !nav.checkVisibility()) {
            return undefined;
        }
        const filters = [...nav.querySelectorAll(".search-filter")];
        const label = (filter: Element): string =>
            [...filter.children].map((part) => part.textContent).join("|");
        return {
            labels: filters.map((filter) => label(filter)),
            active: filters.filter((filter) => filter.classList.contains("active")).map(label),
            current: filters
                .filter((filter) => filter.getAttribute("aria-current") === "page")
                .map(label),
            nav_label: nav.getAttribute("aria-label"),
            hash: window.location.hash,
        };
    });
}

// Waits until the filters show these labels, and returns them.
async function wait_for_labels(page: Page, labels: string[]): Promise<Bar | undefined> {
    await page
        .waitForFunction(
            (labels: string[]) => {
                const filters = [...document.querySelectorAll(".search-filters .search-filter")];
                return (
                    JSON.stringify(
                        filters.map((filter) =>
                            [...filter.children].map((part) => part.textContent).join("|"),
                        ),
                    ) === JSON.stringify(labels)
                );
            },
            {timeout: 15000},
            labels,
        )
        .catch(() => undefined);
    return await bar(page);
}

// The test server doesn't index messages for keyword search, so
// searches here find nothing; the filters work without results.
// Waits until the filter for this kind of messages is the active one.
async function wait_for_active(page: Page, kind: string): Promise<boolean> {
    return await page
        .waitForSelector(`.search-filter.active[data-search-filter="${kind}"]`, {timeout: 10000})
        .then(() => true)
        .catch(() => false);
}

async function open(page: Page, hash: string, wait_for = ".search-filters"): Promise<void> {
    const url = `${base_url}${hash}`;
    const is_same_url = page.url() === url;
    await page.goto(url);
    if (is_same_url) {
        // Going to the same URL doesn't open the view again.
        await page.reload();
    }
    await page.waitForSelector(wait_for, {visible: true});
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
}

async function wait_for_hash(page: Page, hash: string): Promise<boolean> {
    return await page
        .waitForFunction((hash: string) => window.location.hash === hash, {timeout: 10000}, hash)
        .then(() => true)
        .catch(() => false);
}

type CountResponse = {status: number; body: object};

// Answers the count requests of the filters.
async function respond_to_counts(
    page: Page,
    respond: (narrow: {operator: string; operand: string; negated?: boolean}[]) => CountResponse,
): Promise<void> {
    page.removeAllListeners("request");
    await page.setRequestInterception(true);
    page.on("request", (request: HTTPRequest) => {
        if (request.isInterceptResolutionHandled()) {
            return;
        }
        const url = new URL(request.url());
        if (url.pathname !== "/json/messages/count") {
            void request.continue();
            return;
        }
        const response = respond(JSON.parse(url.searchParams.get("narrow")!));
        void request.respond({
            status: response.status,
            contentType: "application/json",
            body: JSON.stringify(response.body),
        });
    });
}

function count(count: number, count_is_limited = false): CountResponse {
    return {status: 200, body: {result: "success", msg: "", count, count_is_limited}};
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

async function check_narrow_window(page: Page, language: string, labels: string[]): Promise<void> {
    await open(page, `#narrow/search/${keyword}`);
    const shown = await wait_for_labels(page, labels);
    await page.focus('.search-filter[data-search-filter="direct"]');
    await page.keyboard.press("Tab");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const narrow = await page.evaluate(() => {
        const nav = document.querySelector(".search-filters")!;
        const box = nav.getBoundingClientRect();
        const filters = [...nav.querySelectorAll(".search-filter")];
        const focused = document.activeElement!;
        const focused_box = focused.getBoundingClientRect();
        return {
            height: box.height,
            expected_height: 2.75 * Number.parseFloat(getComputedStyle(nav).fontSize),
            scrolls: nav.scrollWidth > nav.clientWidth,
            no_filter_cut: filters.every((filter) => filter.scrollWidth <= filter.clientWidth),
            focused_in_view: focused_box.left >= box.left && focused_box.right <= box.right,
            focused_underline: getComputedStyle(focused).textDecorationLine,
            focused_filter: focused.getAttribute("data-search-filter"),
            focused_box: [focused_box.left, focused_box.right],
            nav_box: [box.left, box.right],
            scroll_left: nav.scrollLeft,
        };
    });
    check(
        `${language}, in a 480px window the filters keep one row, and a focused filter scrolls into view whole, not underlined`,
        JSON.stringify(shown?.labels) === JSON.stringify(labels) &&
            Math.abs(narrow.height - narrow.expected_height) < 0.5 &&
            narrow.no_filter_cut &&
            narrow.focused_filter === "channels" &&
            narrow.focused_in_view &&
            narrow.focused_underline === "none",
        JSON.stringify(narrow),
    );
}

async function search_filters_test(page: Page): Promise<void> {
    await page.setViewport({width: 1280, height: 900});
    await common.log_in(page);
    await api(page, "PATCH", "/json/settings", "color_scheme=3&web_font_size_px=15");
    await page.reload();

    // The counts as the server gives them.
    await open(page, `#narrow/search/${keyword}`);
    const all = await wait_for_labels(page, ["All|0", "Direct and group messages|0", "Channels|0"]);
    check(
        "a keyword search has the three filters with the server's counts, All active",
        JSON.stringify(all?.labels) ===
            JSON.stringify(["All|0", "Direct and group messages|0", "Channels|0"]) &&
            JSON.stringify(all?.active) === JSON.stringify(["All|0"]) &&
            JSON.stringify(all?.current) === JSON.stringify(["All|0"]) &&
            all?.nav_label === "Search filters",
        JSON.stringify(all),
    );

    // Each filter shows the count for its own search.
    await respond_to_counts(page, (narrow) => {
        const is_dm = narrow.find((term) => term.operator === "is" && term.operand === "dm");
        if (is_dm === undefined) {
            return count(5);
        }
        return is_dm.negated ? count(3) : count(2);
    });
    await open(page, `#narrow/search/${keyword}`);
    const counted = await wait_for_labels(page, [
        "All|5",
        "Direct and group messages|2",
        "Channels|3",
    ]);
    check(
        "each filter shows the count for its search",
        JSON.stringify(counted?.labels) ===
            JSON.stringify(["All|5", "Direct and group messages|2", "Channels|3"]),
        JSON.stringify(counted),
    );
    const dot = await page.$eval(
        ".search-filter-count",
        (count) => getComputedStyle(count, "::before").content,
    );
    check("the count follows its label after a dot", dot === '"·"', dot);

    const layout = await page.evaluate(() => {
        const navbar = document.querySelector("#navbar-fixed-container")!.getBoundingClientRect();
        const nav = document.querySelector(".search-filters")!.getBoundingClientRect();
        const gutter = document.querySelector("#top-of-feed-gutter")!;
        return {
            navbar_bottom: navbar.bottom,
            top: nav.top,
            bottom: nav.bottom,
            height: nav.height,
            // 44px at 16px/1em.
            expected_height:
                2.75 *
                Number.parseFloat(
                    getComputedStyle(document.querySelector(".search-filters")!).fontSize,
                ),
            gutter_sticks_at: Number.parseFloat(getComputedStyle(gutter).top),
        };
    });
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
    check(
        "the filters sit below the navbar, and the feed's sticky elements stick below them",
        near(layout.top, layout.navbar_bottom) &&
            near(layout.height, layout.expected_height) &&
            near(layout.gutter_sticks_at, layout.bottom),
        JSON.stringify(layout),
    );
    await shot(page, "light");

    // Choosing a filter.
    await page.click('.search-filter[data-search-filter="channels"]');
    const channels_hash = await wait_for_hash(page, `#narrow/search/${keyword}/-is/dm`);
    await wait_for_active(page, "channels");
    const channels = await wait_for_labels(page, [
        "All|5",
        "Direct and group messages|2",
        "Channels|3",
    ]);
    const pills = await page.$$eval("#searchbox .pill", (pills) =>
        pills.map((pill) => pill.textContent.replaceAll(/\s+/g, "")),
    );
    check(
        "Channels adds -is:dm to the search, shown as a pill",
        channels_hash &&
            JSON.stringify(channels?.active) === JSON.stringify(["Channels|3"]) &&
            JSON.stringify(pills) === JSON.stringify(["-is:dm"]),
        JSON.stringify({channels, pills}),
    );
    await shot(page, "channels");

    await page.goBack();
    const back = await wait_for_hash(page, `#narrow/search/${keyword}`);
    await wait_for_active(page, "all");
    const back_bar = await wait_for_labels(page, [
        "All|5",
        "Direct and group messages|2",
        "Channels|3",
    ]);
    check(
        "Back returns to the search without the filter",
        back && JSON.stringify(back_bar?.active) === JSON.stringify(["All|5"]),
        JSON.stringify(back_bar),
    );

    // Keyboard.
    await page.focus('.search-filter[data-search-filter="all"]');
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-search-filter"),
    );
    await page.keyboard.press("Enter");
    const direct_hash = await wait_for_hash(page, `#narrow/search/${keyword}/is/dm`);
    await wait_for_active(page, "direct");
    const direct = await wait_for_labels(page, [
        "All|5",
        "Direct and group messages|2",
        "Channels|3",
    ]);
    check(
        "Tab moves between the filters, and Enter on Direct and group messages adds is:dm",
        focused === "direct" &&
            direct_hash &&
            JSON.stringify(direct?.active) === JSON.stringify(["Direct and group messages|2"]),
        JSON.stringify({focused, direct}),
    );

    // Views without the filters.
    const rows = ".focused-message-list .message_row";
    const no_results = ".empty_feed_notice";
    const without: [string, string, string][] = [
        ["a search in a channel", `#narrow/channel/Verona/search/${keyword}`, no_results],
        ["a search in a topic", `#narrow/channel/Verona/topic/test/search/${keyword}`, no_results],
        ["the combined feed", "#feed", rows],
        ["a channel", "#narrow/channel/Verona", rows],
        ["direct messages", "#narrow/is/dm", no_results],
    ];
    const shown_in: string[] = [];
    for (const [name, hash, wait_for] of without) {
        await open(page, hash, wait_for);
        const empty = await page.$eval("#search-filters-container", (container) => ({
            children: container.children.length,
            height: container.getBoundingClientRect().height,
        }));
        if ((await bar(page)) !== undefined || empty.children !== 0 || empty.height !== 0) {
            shown_in.push(name);
        }
    }
    check(
        "searches limited to a channel or topic and views other than searches have no filters",
        shown_in.length === 0,
        JSON.stringify(shown_in),
    );

    // Counts past the limit, and failed counts.
    await respond_to_counts(page, () => count(1000, true));
    await open(page, `#narrow/search/${keyword}`);
    const limited = await wait_for_labels(page, [
        "All|1000+",
        "Direct and group messages|1000+",
        "Channels|1000+",
    ]);
    check(
        "more than 1000 matches show as 1000+",
        JSON.stringify(limited?.labels) ===
            JSON.stringify(["All|1000+", "Direct and group messages|1000+", "Channels|1000+"]),
        JSON.stringify(limited),
    );
    await respond_to_counts(page, () => ({
        status: 500,
        body: {result: "error", msg: "Internal server error"},
    }));
    await open(page, `#narrow/search/${keyword}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const failed = await bar(page);
    check(
        "a failed count leaves the filter without a number",
        JSON.stringify(failed?.labels) ===
            JSON.stringify(["All|", "Direct and group messages|", "Channels|"]),
        JSON.stringify(failed),
    );
    page.removeAllListeners("request");
    await page.setRequestInterception(false);

    // Dark theme.
    await api(page, "PATCH", "/json/settings", "color_scheme=2");
    await page.reload();
    await open(page, `#narrow/search/${keyword}/-is/dm`);
    await wait_for_labels(page, ["All|0", "Direct and group messages|0", "Channels|0"]);
    const dark = await page.evaluate(() => {
        const active = document.querySelector(".search-filter.active")!;
        const nav = document.querySelector(".search-filters")!;
        return {
            active: getComputedStyle(active).backgroundColor,
            nav: getComputedStyle(nav).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
        };
    });
    check(
        "dark theme: the active filter has the color of own messages, the bar the feed's",
        dark.active === "rgb(52, 54, 92)" && dark.nav === dark.body,
        JSON.stringify(dark),
    );
    await shot(page, "dark");

    // Russian, and a 480px window, with the longest counts.
    await api(page, "PATCH", "/json/settings", "default_language=ru&color_scheme=3");
    await respond_to_counts(page, () => count(1000, true));
    await page.reload();
    await open(page, `#narrow/search/${keyword}`);
    const ru = await wait_for_labels(page, ["Все|1000+", "Личные и группы|1000+", "Каналы|1000+"]);
    check(
        "in Russian, the filters read Все, Личные и группы, Каналы",
        JSON.stringify(ru?.labels) ===
            JSON.stringify(["Все|1000+", "Личные и группы|1000+", "Каналы|1000+"]) &&
            ru?.nav_label === "Фильтры поиска",
        JSON.stringify(ru),
    );
    await shot(page, "ru");
    await page.setViewport({width: 480, height: 900});
    await check_narrow_window(page, "in Russian", [
        "Все|1000+",
        "Личные и группы|1000+",
        "Каналы|1000+",
    ]);
    await shot(page, "ru-480");
    await api(page, "PATCH", "/json/settings", "default_language=en");
    await page.reload();
    await check_narrow_window(page, "in English", [
        "All|1000+",
        "Direct and group messages|1000+",
        "Channels|1000+",
    ]);
    await shot(page, "en-480");
    page.removeAllListeners("request");
    await page.setRequestInterception(false);

    await page.setViewport({width: 1280, height: 900});
    await api(page, "PATCH", "/json/settings", "default_language=en&color_scheme=1");
    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(search_filters_test);
