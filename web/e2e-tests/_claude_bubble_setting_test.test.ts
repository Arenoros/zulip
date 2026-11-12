import type {Page} from "puppeteer";

import * as common from "./lib/common.ts";

const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
    const line = `${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`;
    results.push(line);
    console.log(line);
}

const base_url = "http://zulip.zulipdev.com:9981/";

async function shot(page: Page, selector: string, name: string, pad = 8): Promise<void> {
    const box = await page.evaluate(
        (selector, pad) => {
            const element = document.querySelector(selector)!;
            element.scrollIntoView({block: "center"});
            const rect = element.getBoundingClientRect();
            return {
                x: Math.max(0, rect.left - pad) + window.scrollX,
                y: Math.max(0, rect.top - pad) + window.scrollY,
                width: rect.width + 2 * pad,
                height: rect.height + 2 * pad,
            };
        },
        selector,
        pad,
    );
    await page.screenshot({
        path: `var/puppeteer/bubbles-${name}.png`,
        clip: box,
        captureBeyondViewport: false,
    });
}

async function is_checked(page: Page, selector: string): Promise<boolean> {
    return await page.$eval(selector, (input) => (input as HTMLInputElement).checked);
}

async function wait_checked(page: Page, selector: string, value: boolean): Promise<void> {
    await page.waitForFunction(
        (selector, value) => document.querySelector<HTMLInputElement>(selector)?.checked === value,
        // The default polling uses animation frames, which stop in a background tab.
        {polling: 100},
        selector,
        value,
    );
}

const user_checkbox = "#user_web_direct_message_bubbles";
const realm_checkbox = "#realm_web_direct_message_bubbles";

async function visual_test(page: Page): Promise<void> {
    await common.log_in(page);

    // Two windows of the same user.
    await page.goto(`${base_url}#settings/preferences`);
    await page.waitForSelector(user_checkbox);
    const other = await page.browser().newPage();
    await other.setViewport({width: 1280, height: 1024});
    await other.goto(`${base_url}#settings/preferences`);
    await other.waitForSelector(user_checkbox);
    await page.bringToFront();

    check("the setting is on by default", await is_checked(page, user_checkbox));
    const label_text = await page.$eval(
        `${user_checkbox}_label`,
        (label) => label.textContent?.trim() ?? "",
    );
    check(
        "the checkbox has its label",
        label_text === "Show direct messages as chat bubbles",
        label_text,
    );
    const help_href = await page.$eval(
        `${user_checkbox}_label .help_link_widget`,
        (link) => link.getAttribute("href") ?? "",
    );
    check(
        "the help link points to the help section",
        help_href === "/help/direct-messages#show-direct-messages-as-chat-bubbles",
        help_href,
    );
    await shot(page, "#user-preferences .information-settings", "user-information");

    // Turning it off saves it and shows up in the other window.
    await page.click(`${user_checkbox} + .rendered-checkbox`);
    check("the setting can be turned off", !(await is_checked(page, user_checkbox)));
    await wait_checked(other, user_checkbox, false);
    check("the other window follows without a reload", true);

    // It stays off after a reload.
    await other.bringToFront();
    await other.reload();
    await other.waitForSelector(user_checkbox);
    check("the setting is saved", !(await is_checked(other, user_checkbox)));
    await page.bringToFront();

    await page.click(`${user_checkbox} + .rendered-checkbox`);
    await wait_checked(other, user_checkbox, true);
    check("the setting can be turned back on", true);
    await other.close();
    await page.bringToFront();

    // The default for new users.
    await page.goto(`${base_url}#organization/organization-level-user-defaults`);
    await page.waitForSelector(realm_checkbox);
    check("the organization default is on", await is_checked(page, realm_checkbox));
    await shot(page, "#realm-user-default-settings .information-settings", "realm-information");
    const reset_buttons = await page.$$eval(
        `${realm_checkbox}`,
        (inputs) =>
            inputs[0]!.closest(".input-group")!.querySelectorAll(".reset-user-setting-to-default")
                .length,
    );
    check("the organization default has a reset button", reset_buttons === 1, String(reset_buttons));

    await page.click(`${realm_checkbox} + .rendered-checkbox`);
    await page.evaluate(() => {
        document
            .querySelector("#realm-user-default-settings .information-settings .save-button")!
            .dispatchEvent(new MouseEvent("click", {bubbles: true}));
    });
    await page.waitForSelector(
        "#realm-user-default-settings .information-settings .save-button",
        {hidden: true},
    );
    await page.reload();
    await page.waitForSelector(realm_checkbox);
    check("the organization default can be turned off", !(await is_checked(page, realm_checkbox)));

    await page.click(`${realm_checkbox} + .rendered-checkbox`);
    await page.evaluate(() => {
        document
            .querySelector("#realm-user-default-settings .information-settings .save-button")!
            .dispatchEvent(new MouseEvent("click", {bubbles: true}));
    });
    await page.waitForSelector(
        "#realm-user-default-settings .information-settings .save-button",
        {hidden: true},
    );
    await page.reload();
    await page.waitForSelector(realm_checkbox);
    check("the organization default can be turned back on", await is_checked(page, realm_checkbox));

    const failures = results.filter((r) => r.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
}

await common.run_test(visual_test);
