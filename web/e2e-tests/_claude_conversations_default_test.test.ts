import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

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

async function channel_link(page: Page, name: string): Promise<string> {
    const stream_id = await page.evaluate((name) => zulip_test.get_stream_id(name), name);
    return `#stream_filters li.narrow-filter[data-stream-id="${stream_id}"]`;
}

async function click_channel(page: Page, name: string): Promise<string> {
    await page.click(`${await channel_link(page, name)} .stream-name`);
    await page.waitForSelector(".focused-message-list .message_row", {visible: true});
    return await page.evaluate(() => window.location.hash);
}

async function conversations_default_test(page: Page): Promise<void> {
    await common.log_in(page);

    // The test user never chose a view for channels.
    const href = await page.$eval(
        `${await channel_link(page, "Verona")} a.subscription_block`,
        (link) => link.getAttribute("href") ?? "",
    );
    check(
        "Conversations is the default view of channels",
        href.startsWith("#conversations/channel/"),
        href,
    );
    let hash = await click_channel(page, "Verona");
    check(
        "clicking on a channel opens its conversations",
        hash.startsWith("#conversations/channel/") &&
            (await page.$(".focused-message-list.conversations-view")) !== null,
        hash,
    );

    await set_setting(page, "web_channel_default_view=2");
    await page.reload();
    await page.waitForSelector("#stream_filters .stream-name", {visible: true});
    hash = await click_channel(page, "Verona");
    check(
        "with the channel feed chosen, clicking on a channel opens its feed",
        hash.startsWith("#narrow/channel/") &&
            (await page.$(".focused-message-list.conversations-view")) === null,
        hash,
    );
    await set_setting(page, "web_channel_default_view=5");

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(conversations_default_test);
