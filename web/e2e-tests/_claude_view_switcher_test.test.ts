import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";
const shot_prefix = process.env["SHOT_PREFIX"] ?? "view-switcher";

async function api(page: Page, method: string, url: string, body: string): Promise<void> {
    await page.waitForSelector('input[name="csrfmiddlewaretoken"]');
    const status = await page.evaluate(
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
                body,
            });
            return response.status;
        },
        method,
        url,
        body,
    );
    if (status !== 200) {
        throw new Error(`${method} ${url} ${body}: ${status}`);
    }
}

type Switcher = {
    labels: string[];
    active: string[];
    current: string[];
    icons: string[];
    title: boolean;
    hash: string;
};

async function switcher(page: Page): Promise<Switcher | undefined> {
    return await page.evaluate(() => {
        const nav = document.querySelector("#message_view_header .view-switcher");
        if (nav === null || !nav.checkVisibility()) {
            return undefined;
        }
        const segments = [...nav.querySelectorAll(".view-switcher-segment")];
        return {
            labels: segments.map((segment) => segment.textContent.trim()),
            active: segments
                .filter((segment) => segment.classList.contains("active"))
                .map((segment) => segment.textContent.trim()),
            current: segments
                .filter((segment) => segment.getAttribute("aria-current") === "page")
                .map((segment) => segment.textContent.trim()),
            icons: segments.map(
                (segment) =>
                    [...(segment.querySelector(".zulip-icon")?.classList ?? [])].find(
                        (name) => name !== "zulip-icon",
                    ) ?? "",
            ),
            title:
                document.querySelector("#message_view_header .message-header-navbar-title") !==
                null,
            hash: window.location.hash,
        };
    });
}

async function open(page: Page, hash: string): Promise<void> {
    await page.goto(`${base_url}${hash}`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    await page.waitForSelector("#message_view_header > *", {visible: true});
    await page.mouse.move(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
}

async function wait_for_active(page: Page, label: string): Promise<boolean> {
    return await common.succeeds(
        page.waitForFunction(
            (label: string) =>
                document
                    .querySelector("#message_view_header .view-switcher-segment.active")
                    ?.textContent.trim() === label,
            {timeout: 10000},
            label,
        ),
    );
}

async function shot(page: Page, name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({path: `var/puppeteer/${shot_prefix}-${name}.png`});
}

type Fit = {overflow: boolean; gap_to_search: number; segments_inside: boolean};

async function fit(page: Page): Promise<Fit> {
    return await page.evaluate(() => {
        const header = document.querySelector("#message_view_header")!;
        const nav = header.querySelector(".view-switcher")!;
        const segments = [...nav.querySelectorAll(".view-switcher-segment")];
        const search = document
            .querySelector("#searchbox-input-container")!
            .getBoundingClientRect();
        const last = segments.at(-1)!.getBoundingClientRect();
        return {
            overflow: nav.scrollWidth > nav.clientWidth + 1,
            gap_to_search: Math.round(search.left - last.right),
            segments_inside: segments.every((segment) => {
                const box = segment.getBoundingClientRect();
                const header_box = header.getBoundingClientRect();
                return box.top >= header_box.top && box.bottom <= header_box.bottom;
            }),
        };
    });
}

async function view_switcher_test(page: Page): Promise<void> {
    await page.setViewport({width: 1280, height: 900});
    await common.log_in(page);
    await api(
        page,
        "PATCH",
        "/json/settings",
        "web_home_view=all_messages&color_scheme=3&web_font_size_px=15",
    );
    await page.reload();

    // The combined feed, also as the home view.
    await open(page, "");
    const home = await switcher(page);
    check(
        "the combined feed has the three segments instead of its title, as the home view too",
        JSON.stringify(home?.labels) === JSON.stringify(["Combined feed", "Mentions", "Starred"]) &&
            JSON.stringify(home?.active) === JSON.stringify(["Combined feed"]) &&
            JSON.stringify(home?.current) === JSON.stringify(["Combined feed"]) &&
            JSON.stringify(home?.icons) ===
                JSON.stringify([
                    "zulip-icon-all-messages",
                    "zulip-icon-at-sign",
                    "zulip-icon-star",
                ]) &&
            home?.title === false,
        JSON.stringify(home),
    );
    const layout = await fit(page);
    check(
        "the segments sit in the 40px header, clear of the search",
        !layout.overflow && layout.segments_inside && layout.gap_to_search > 0,
        JSON.stringify(layout),
    );
    await shot(page, "light");

    // Switching without reloading the web app.
    await page.evaluate(() => {
        document.documentElement.dataset["switcherMarker"] = "true";
    });
    await page.click("#message_view_header .view-switcher-segment:nth-child(2)");
    const mentions = await wait_for_active(page, "Mentions");
    const mentions_state = await switcher(page);
    await page.click("#message_view_header .view-switcher-segment:nth-child(3)");
    const starred = await wait_for_active(page, "Starred");
    const starred_state = await switcher(page);
    const kept = await page.evaluate(
        () => document.documentElement.dataset["switcherMarker"] === "true",
    );
    check(
        "the segments open mentions and starred messages without reloading",
        mentions &&
            mentions_state?.hash === "#narrow/is/mentioned" &&
            starred &&
            starred_state?.hash === "#narrow/is/starred" &&
            kept,
        JSON.stringify({mentions_state, starred_state, kept}),
    );
    await shot(page, "starred");

    // Keyboard.
    await page.focus("#message_view_header .view-switcher-segment:nth-child(1)");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent.trim());
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    await page.keyboard.press("Enter");
    const by_keyboard = await wait_for_active(page, "Combined feed");
    check(
        "Tab moves between the segments and Enter opens one",
        focused === "Mentions" && by_keyboard,
        JSON.stringify({focused, by_keyboard}),
    );

    // Other views keep their header.
    const others: [string, string][] = [
        ["reactions", "#narrow/has/reaction/sender/me"],
        ["all direct messages", "#narrow/is/dm"],
        ["a channel feed", "#narrow/channel/3-Verona"],
        ["a sender", "#narrow/sender/me"],
    ];
    const with_switcher: string[] = [];
    for (const [name, hash] of others) {
        await page.goto(`${base_url}${hash}`);
        await page.waitForSelector("#message_view_header > *", {visible: true});
        await new Promise((resolve) => setTimeout(resolve, 800));
        if ((await switcher(page)) !== undefined) {
            with_switcher.push(name);
        }
    }
    check(
        "reactions, direct messages, a channel feed and a sender keep their header",
        with_switcher.length === 0,
        with_switcher.join(", "),
    );

    // Search opens over the segments and gives them back.
    await open(page, "#feed");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Slash");
    // The search bar expands over the header, which is marked hidden.
    const hidden_while_searching = await common.succeeds(
        page.waitForFunction(
            () =>
                document.querySelector(".navbar-search")!.classList.contains("expanded") &&
                document.querySelector("#message_view_header")!.classList.contains("hidden"),
            {timeout: 5000},
        ),
    );
    await page.keyboard.press("Escape");
    const shown_again = await common.succeeds(
        page.waitForFunction(
            () =>
                !document.querySelector("#message_view_header")!.classList.contains("hidden") &&
                document.querySelector("#message_view_header .view-switcher")?.checkVisibility() ===
                    true,
            {timeout: 5000},
        ),
    );
    const back = await switcher(page);
    check(
        "search opens in place of the segments and closes back to them",
        hidden_while_searching && shown_again && back?.active[0] === "Combined feed",
        JSON.stringify({hidden_while_searching, shown_again, back: back?.active}),
    );

    // A header rerender keeps the segments.
    await api(page, "PATCH", "/json/settings", "web_channel_default_view=2");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const rerendered = await switcher(page);
    await api(page, "PATCH", "/json/settings", "web_channel_default_view=5");
    check(
        "a header rerender keeps the segments",
        rerendered?.active[0] === "Combined feed",
        JSON.stringify(rerendered),
    );

    // Dark theme.
    await api(page, "PATCH", "/json/settings", "color_scheme=2");
    await page.reload();
    await open(page, "#feed");
    const colors = await page.evaluate(() => {
        const active = document.querySelector(
            "#message_view_header .view-switcher-segment.active",
        )!;
        const other = document.querySelector(
            "#message_view_header .view-switcher-segment:not(.active)",
        )!;
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--color-background-own-message-bubble)";
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
            active: getComputedStyle(active).backgroundColor,
            other: getComputedStyle(other).backgroundColor,
            expected,
        };
    });
    check(
        "the active segment has the color of own messages, the others none",
        colors.active === colors.expected && colors.other === "rgba(0, 0, 0, 0)",
        JSON.stringify(colors),
    );
    await shot(page, "dark");

    // Russian, in a wide and in a narrow window.
    await api(page, "PATCH", "/json/settings", "default_language=ru");
    await page.reload();
    const labels_shown = async (): Promise<boolean[]> =>
        await page.$$eval("#message_view_header .view-switcher-label", (labels) =>
            labels.map((label) => label.checkVisibility()),
        );
    const widths: Record<number, unknown> = {};
    let wide_ok = true;
    for (const width of [1024, 900, 768]) {
        await page.setViewport({width, height: 900});
        await open(page, "#feed");
        const header = await page.$eval("#message_view_header", (header) => ({
            width: Math.round(header.getBoundingClientRect().width),
            // Below 22em, the segments show only their icons.
            icons_only_below: 22 * Number.parseFloat(getComputedStyle(header).fontSize),
        }));
        const state = {fit: await fit(page), labels: await labels_shown(), header};
        widths[width] = state;
        const labels_expected = header.width >= header.icons_only_below;
        wide_ok &&=
            !state.fit.overflow &&
            state.fit.gap_to_search > 0 &&
            state.labels.every((shown) => shown === labels_expected);
    }
    const ru = await switcher(page);
    check(
        "in Russian, the segments show their labels where the header is wide enough, clear of the search",
        JSON.stringify(ru?.labels) ===
            JSON.stringify(["Объединенная лента", "Упоминания", "Отмеченные"]) && wide_ok,
        JSON.stringify(widths),
    );
    await shot(page, "ru-900");
    await page.setViewport({width: 480, height: 900});
    await open(page, "#feed");
    const ru_fit = await fit(page);
    const narrow_labels = await labels_shown();
    const aria = await page.$$eval("#message_view_header .view-switcher-segment", (segments) =>
        segments.map((segment) => segment.getAttribute("aria-label")),
    );
    check(
        "in a 480px window the segments show only their icons, named for screen readers",
        !ru_fit.overflow &&
            ru_fit.segments_inside &&
            ru_fit.gap_to_search > 0 &&
            narrow_labels.every((shown) => !shown) &&
            JSON.stringify(aria) ===
                JSON.stringify(["Объединенная лента", "Упоминания", "Отмеченные"]),
        JSON.stringify({ru_fit, narrow_labels, aria}),
    );
    await shot(page, "ru-480");

    await page.setViewport({width: 1280, height: 900});
    await api(page, "PATCH", "/json/settings", "default_language=en&color_scheme=1");
    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(view_switcher_test);
