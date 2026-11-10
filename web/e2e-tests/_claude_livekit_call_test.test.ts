import process from "node:process";

import puppeteer, {type Browser, type Page} from "puppeteer";

import * as common from "./lib/common.ts";

const realm_url = "http://zulip.zulipdev.com:9981/";
const call_url = `${realm_url}calls/livekit/join?call_id=424242`;

const results: string[] = [];
function check(name: string, ok: boolean): void {
    results.push(`${ok ? "PASS" : "FAIL"}: ${name}`);
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

async function launch_media_browser(): Promise<Browser> {
    return puppeteer.launch({
        args: [
            `--window-size=${common.window_size.width},${common.window_size.height}`,
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            // Media devices are only available in secure contexts.
            `--unsafely-treat-insecure-origin-as-secure=${realm_url}`,
        ],
        defaultViewport: null,
        headless: true,
    });
}

// Headless Chrome has no screen to capture, so share a canvas instead.
async function fake_screen_share(page: Page): Promise<void> {
    await page.evaluateOnNewDocument(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement("canvas");
            canvas.width = 1280;
            canvas.height = 720;
            const context = canvas.getContext("2d")!;
            let frame = 0;
            setInterval(() => {
                context.fillStyle = "#2a6a4a";
                context.fillRect(0, 0, 1280, 720);
                context.fillStyle = "#ffffff";
                context.font = "64px sans-serif";
                context.fillText(`Shared screen ${frame}`, 80, 360);
                frame += 1;
            }, 100);
            return canvas.captureStream(10);
        };
    });
}

async function api_patch(page: Page, url: string, body: string): Promise<number> {
    return page.evaluate(
        async (url, body) => {
            const csrf_token =
                document.querySelector<HTMLInputElement>('input[name="csrfmiddlewaretoken"]')
                    ?.value ?? "";
            const response = await fetch(url, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRFToken": csrf_token,
                },
                body,
            });
            return response.status;
        },
        url,
        body,
    );
}

async function pressed(page: Page, selector: string): Promise<string | null> {
    return page.$eval(selector, (element) => element.getAttribute("aria-pressed"));
}

async function livekit_call_test(page: Page): Promise<void> {
    await common.log_in(page);
    check(
        "set LiveKit as call provider",
        (await api_patch(page, "/json/realm", "video_chat_provider=10")) === 200,
    );
    await page.waitForFunction(() => zulip_test.realm.realm_video_chat_provider === 10);

    await page.keyboard.press("KeyC");
    await page.waitForSelector("#compose-textarea", {visible: true});
    check(
        "audio call button is shown",
        await page.$eval(
            ".compose-control-buttons-container .audio_link",
            (element) => (element as HTMLElement).offsetParent !== null,
        ),
    );
    await page.click(".compose-control-buttons-container .video_link");
    await page.waitForFunction(() =>
        document
            .querySelector<HTMLTextAreaElement>("#compose-textarea")
            ?.value.includes("/calls/livekit/join?call_id="),
    );
    check("video call button inserts a LiveKit link", true);
    await common.screenshot(page, "livekit-0-compose");

    const cordelia_password = process.env["CORDELIA_PASSWORD"];
    if (cordelia_password === undefined) {
        throw new Error("CORDELIA_PASSWORD is not set");
    }

    const browser_a = await launch_media_browser();
    const browser_b = await launch_media_browser();
    try {
        const page_a = await browser_a.newPage();
        const page_b = await browser_b.newPage();
        for (const [label, participant_page] of [
            ["A", page_a],
            ["B", page_b],
        ] as const) {
            participant_page.on("console", (message) => {
                console.log(`${label} console ${message.type()}: ${message.text()}`);
            });
            participant_page.on("pageerror", (error) => {
                console.log(`${label} pageerror: ${String(error)}`);
            });
        }
        await common.log_in(page_a);
        await fake_screen_share(page_b);
        await common.log_in(page_b, {username: "cordelia@zulip.com", password: cordelia_password});

        await page_a.goto(call_url);
        await page_a.waitForSelector(".livekit-call-tile .livekit-call-video", {visible: true});
        await page_a.waitForFunction(
            () => document.querySelector("#livekit-call-camera")?.getAttribute("aria-pressed") === "true",
        );
        check("microphone is on", (await pressed(page_a, "#livekit-call-microphone")) === "true");
        check("camera is on", (await pressed(page_a, "#livekit-call-camera")) === "true");
        check(
            "screen share is off",
            (await pressed(page_a, "#livekit-call-screen-share")) === "false",
        );
        check(
            "own tile is labeled",
            (await page_a.$eval(".livekit-call-tile-name", (element) => element.textContent)) ===
                "Desdemona (you)",
        );
        await common.screenshot(page_a, "livekit-1-alone");

        await page_b.goto(call_url);
        await page_a.waitForFunction(
            () => document.querySelectorAll(".livekit-call-tile .livekit-call-video").length === 2,
        );
        await page_b.waitForFunction(
            () => document.querySelectorAll(".livekit-call-tile .livekit-call-video").length === 2,
        );
        check("both participants see two tiles", true);
        await common.screenshot(page_a, "livekit-2-two-participants");

        await page_b.click("#livekit-call-screen-share");
        await page_a.waitForSelector(".livekit-call-stage-active .livekit-call-video", {
            visible: true,
        });
        await page_b.waitForFunction(
            () =>
                document.querySelector("#livekit-call-screen-share")?.getAttribute("aria-pressed") ===
                "true",
        );
        const layout = await page_a.evaluate(() => {
            const stage = document.querySelector(".livekit-call-stage")!.getBoundingClientRect();
            const tile = document.querySelector(".livekit-call-tile")!.getBoundingClientRect();
            return {stage: stage.height * stage.width, tile: tile.height * tile.width};
        });
        console.log("stage and tile areas", JSON.stringify(layout));
        check("shared screen is larger than tiles", layout.stage > 4 * layout.tile);
        check(
            "browser share is not marked controllable",
            (await page_a.$(".livekit-call-screen-share-label")) === null &&
                (await page_b.$(".livekit-call-screen-share-label")) === null,
        );
        await common.screenshot(page_a, "livekit-3-screen-share");
        await common.screenshot(page_b, "livekit-3-screen-share-presenter");

        await page_b.click("#livekit-call-camera");
        await page_a.waitForFunction(
            () => document.querySelectorAll(".livekit-call-tile-camera-off").length === 1,
        );
        check("camera off hides the video", true);

        await page_b.click("#livekit-call-screen-share");
        await page_a.waitForSelector(".livekit-call-stage-active", {hidden: true});
        check("stopping the share removes the stage", true);
        await common.screenshot(page_a, "livekit-4-camera-off");

        for (const [width, height] of [
            [1920, 1080],
            [1280, 800],
            [768, 1024],
            [480, 800],
        ] as const) {
            await page_a.setViewport({width, height});
            await common.screenshot(page_a, `livekit-5-width-${width}`);
        }
        await page_a.setViewport({width: 1400, height: 1024});

        check(
            "switch to dark theme",
            (await api_patch(page, "/json/settings", "color_scheme=2")) === 200,
        );
        await page_a.reload();
        await page_a.waitForFunction(
            () => document.querySelectorAll(".livekit-call-tile").length === 2,
        );
        check(
            "dark theme applied",
            await page_a.evaluate(() => document.documentElement.classList.contains("dark-theme")),
        );
        await page_b.click("#livekit-call-screen-share");
        await page_a.waitForSelector(".livekit-call-stage-active .livekit-call-video", {
            visible: true,
        });
        await common.screenshot(page_a, "livekit-6-dark");
        await page_b.click("#livekit-call-screen-share");

        await page_b.click("#livekit-call-leave");
        await page_b.waitForFunction(
            () =>
                document.querySelector(".livekit-call-status")?.textContent ===
                "You left the call.",
        );
        await page_a.waitForFunction(
            () => document.querySelectorAll(".livekit-call-tile").length === 1,
        );
        check("leaving updates both sides", true);
        check(
            "controls are disabled after leaving",
            await page_b.$eval("#livekit-call-leave", (element) => (element as HTMLButtonElement).disabled),
        );
        await common.screenshot(page_b, "livekit-7-left");

        await page_b.goto(`${call_url}&voice_only=true`);
        await page_b.waitForFunction(
            () =>
                document.querySelector("#livekit-call-microphone")?.getAttribute("aria-pressed") ===
                "true",
        );
        check("voice call starts without camera", (await pressed(page_b, "#livekit-call-camera")) === "false");
        await common.screenshot(page_b, "livekit-8-voice-call");

        // Share from a desktop app that supports remote control.
        await page_b.evaluateOnNewDocument(() => {
            window.electron_bridge = {
                send_event: () => true,
                on_event() {
                    /* Not used by the call page. */
                },
                get_remote_control_supported: () => true,
            };
        });
        await page_b.goto(call_url);
        await page_b.waitForFunction(
            () =>
                document.querySelector("#livekit-call-microphone")?.getAttribute("aria-pressed") ===
                "true",
        );
        await page_b.click("#livekit-call-screen-share");
        await page_a.waitForSelector(".livekit-call-screen-share-label", {visible: true});
        await page_b.waitForSelector(".livekit-call-screen-share-label", {visible: true});
        check(
            "desktop share is marked controllable for viewers",
            (await page_a.$eval(".livekit-call-screen-share-label", (element) => element.textContent)) ===
                "Remote control available",
        );
        check(
            "viewers can request control",
            (await page_a.$eval(".livekit-call-screen-share-button", (element) =>
                (element as HTMLButtonElement).hidden ? null : element.textContent,
            )) === "Request control",
        );
        check(
            "the presenter cannot request control",
            await page_b.$eval(
                ".livekit-call-screen-share-button",
                (element) => (element as HTMLButtonElement).hidden === true,
            ),
        );
        async function controls_layout(controls_page: Page) {
            return controls_page.evaluate(() => {
                const rect = (selector: string) =>
                    document.querySelector(selector)!.getBoundingClientRect();
                const share = rect(".livekit-call-screen-share");
                const video = rect(".livekit-call-screen-share .livekit-call-video");
                const controls = rect(".livekit-call-screen-share-controls");
                const button = rect(".livekit-call-screen-share-button");
                const label = document.querySelector(".livekit-call-screen-share-label")!;
                const font_size = Number.parseFloat(getComputedStyle(label).fontSize);
                return {
                    gap_em: (controls.top - video.bottom) / font_size,
                    left: controls.left - share.left,
                    controls_bottom: share.bottom - controls.bottom,
                    button_inside: button.right <= share.right + 0.5,
                    label_truncated: label.scrollWidth > label.clientWidth,
                    video_height: video.height,
                };
            });
        }
        for (const [width, height] of [
            [1920, 1080],
            [1280, 800],
            [768, 1024],
            [480, 800],
        ] as const) {
            await page_a.setViewport({width, height});
            const layout = await controls_layout(page_a);
            console.log(`controls layout at ${width}px`, JSON.stringify(layout));
            check(
                `controls sit below the shared screen at ${width}px`,
                Math.abs(layout.gap_em - 0.5) < 0.05 &&
                    Math.abs(layout.left) < 0.5 &&
                    Math.abs(layout.controls_bottom) < 0.5 &&
                    layout.button_inside &&
                    layout.video_height > 100,
            );
            await common.screenshot(page_a, `livekit-9-controllable-viewer-${width}`);
        }
        await page_a.setViewport({width: 1400, height: 1024});
        await common.screenshot(page_b, "livekit-9-controllable-presenter");
        const shown_height = (await controls_layout(page_a)).video_height;
        await page_a.evaluate(() => {
            document.querySelector<HTMLButtonElement>(".livekit-call-screen-share-button")!.hidden =
                true;
        });
        const hidden_height = (await controls_layout(page_a)).video_height;
        console.log("video height with and without the button", shown_height, hidden_height);
        check("the shared screen does not move when the button hides", shown_height === hidden_height);
        check(
            "a hidden button cannot be focused",
            await page_a.evaluate(() => {
                const button = document.querySelector<HTMLButtonElement>(
                    ".livekit-call-screen-share-button",
                )!;
                button.focus();
                return document.activeElement !== button;
            }),
        );
        await page_a.evaluate(() => {
            document.querySelector<HTMLButtonElement>(".livekit-call-screen-share-button")!.hidden =
                false;
        });
        // Translations may be much longer than English.
        await page_a.evaluate(() => {
            document.querySelector(".livekit-call-screen-share-label")!.textContent =
                "Remote control available ".repeat(6);
        });
        await page_a.setViewport({width: 480, height: 800});
        const long_layout = await controls_layout(page_a);
        console.log("controls layout with a long label", JSON.stringify(long_layout));
        check(
            "a long label is truncated and keeps the button visible",
            long_layout.label_truncated && long_layout.button_inside,
        );
        await common.screenshot(page_a, "livekit-9-controllable-long-label");
        await page_b.click("#livekit-call-screen-share");
        await page_a.waitForSelector(".livekit-call-stage-active", {hidden: true});
        check("stopping a controllable share removes it", true);
    } catch (error) {
        for (const [index, open_page] of [
            ...(await browser_a.pages()),
            ...(await browser_b.pages()),
        ].entries()) {
            await common.screenshot(open_page, `livekit-failure-${index}`);
        }
        throw error;
    } finally {
        await browser_a.close();
        await browser_b.close();
        await api_patch(page, "/json/settings", "color_scheme=1");
    }

    const failures = results.filter((result) => result.startsWith("FAIL"));
    console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
    if (failures.length > 0) {
        throw new Error(failures.join("\n"));
    }
}

await common.run_test(livekit_call_test);
