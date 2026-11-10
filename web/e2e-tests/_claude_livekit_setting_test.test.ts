import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean): void {
    results.push(`${ok ? "PASS" : "FAIL"}: ${name}`);
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

async function visible(page: Page, selector: string): Promise<boolean> {
    return page.$eval(selector, (element) => (element as HTMLElement).offsetParent !== null);
}

async function select_provider(page: Page, key: "livekit" | "jitsi_meet"): Promise<void> {
    const id = await page.evaluate(
        (key) => zulip_test.realm.realm_available_video_chat_providers[key]!.id,
        key,
    );
    await page.select("#id_realm_video_chat_provider", String(id));
}

async function livekit_setting_test(page: Page): Promise<void> {
    await common.log_in(page);
    await page.goto("http://zulip.zulipdev.com:9981/#organization/organization-settings");
    await page.waitForSelector("#id_realm_video_chat_provider", {visible: true});

    check(
        "hidden while Jitsi is the provider",
        !(await visible(page, "#realm_enable_livekit_remote_control_setting")),
    );
    await select_provider(page, "livekit");
    check(
        "shown once LiveKit is selected",
        await visible(page, "#realm_enable_livekit_remote_control_setting"),
    );
    check(
        "checked by default",
        await page.$eval(
            "#id_realm_enable_livekit_remote_control",
            (element) => (element as HTMLInputElement).checked,
        ),
    );
    const block = await page.$("#org-compose-settings");
    await block!.screenshot({path: "var/puppeteer/livekit-setting-shown.png"});
    await page.screenshot({path: "var/puppeteer/livekit-setting-page.png"});

    await page.click("#id_realm_enable_livekit_remote_control + .rendered-checkbox");
    await page.waitForSelector('#org-compose-settings .save-button[data-status="unsaved"]', {visible: true});
    await page.click("#org-compose-settings .save-button");
    await page.waitForFunction(
        () =>
            zulip_test.realm.realm_video_chat_provider ===
                zulip_test.realm.realm_available_video_chat_providers.livekit?.id &&
            !zulip_test.realm.realm_enable_livekit_remote_control,
    );
    check("saved as disabled", true);

    await page.setViewport({width: 480, height: 900});
    await block!.screenshot({path: "var/puppeteer/livekit-setting-narrow.png"});
    await page.setViewport({width: 1400, height: 1024});

    await select_provider(page, "jitsi_meet");
    check(
        "hidden again when switching away from LiveKit",
        !(await visible(page, "#realm_enable_livekit_remote_control_setting")),
    );

    const failures = results.filter((result) => result.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} tests passed`);
}

await common.run_test(livekit_setting_test);
