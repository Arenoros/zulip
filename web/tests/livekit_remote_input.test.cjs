"use strict";

const assert = require("node:assert/strict");

const {clock, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {RemoteInput, video_position, wheel_pixels} = zrequire("livekit_remote_input");
const token = "a".repeat(32);

run_test("video coordinates exclude letterboxing", () => {
    const rect = {left: 10, top: 20, width: 1000, height: 1000};
    assert.deepEqual(video_position({clientX: 510, clientY: 520}, rect, 1600, 900), {
        x: 0.5,
        y: 0.5,
    });
    assert.deepEqual(video_position({clientX: 10, clientY: 238.75}, rect, 1600, 900), {x: 0, y: 0});
    assert.deepEqual(video_position({clientX: 1010, clientY: 801.25}, rect, 1600, 900), {
        x: 1,
        y: 1,
    });
    for (const [clientX, clientY] of [
        [9, 520],
        [1011, 520],
        [510, 238],
        [510, 802],
        [NaN, 520],
    ]) {
        assert.equal(video_position({clientX, clientY}, rect, 1600, 900), undefined);
    }
    const wide = {left: 0, top: 0, width: 200, height: 100};
    assert.deepEqual(video_position({clientX: 50, clientY: 50}, wide, 100, 100), {x: 0, y: 0.5});
    assert.equal(video_position({clientX: 49, clientY: 50}, wide, 100, 100), undefined);
    for (const [width, height] of [
        [0, 100],
        [100, 0],
    ]) {
        assert.equal(video_position({clientX: 0, clientY: 0}, rect, width, height), undefined);
        assert.equal(
            video_position({clientX: 0, clientY: 0}, {...rect, width, height}, 100, 100),
            undefined,
        );
    }
});

run_test("wheel units", () => {
    assert.equal(wheel_pixels(120, 0, 1000), 120);
    assert.equal(wheel_pixels(-3, 1, 1000), -120);
    assert.equal(wheel_pixels(2, 2, 1000), 2000);
});

function setup(override, send) {
    const page_window = new EventTarget();
    const page_document = new EventTarget();
    page_document.hidden = false;
    override(global, "window", page_window);
    override(global, "document", page_document);
    const video = new EventTarget();
    Object.assign(video, {
        getBoundingClientRect: () => ({left: 0, top: 0, width: 200, height: 100}),
        videoWidth: 100,
        videoHeight: 100,
        clientWidth: 200,
        clientHeight: 100,
        setPointerCapture: () => {},
        focus() {
            video.dispatchEvent(new Event("focus"));
        },
    });
    const packets = [];
    const keyboard_states = [];
    const remote_input = new RemoteInput(
        video,
        send ??
            (async (token, sequence, event) => {
                packets.push({token, sequence, event});
            }),
        () => {
            keyboard_states.push(remote_input.keyboard_active);
        },
    );
    function emit(type, data = {}, target = video) {
        const event = new Event(type, {cancelable: true});
        Object.assign(
            event,
            {clientX: 100, clientY: 50, pointerId: 1, pointerType: "mouse", button: 0},
            data,
        );
        target.dispatchEvent(event);
        return event.defaultPrevented;
    }
    return {remote_input, video, packets, keyboard_states, emit, page_window, page_document};
}

run_test("moves require a grant and send only the latest position at 60 Hz", async ({override}) => {
    const s = setup(override);
    s.emit("pointermove");
    s.emit("pointerdown");
    s.emit("wheel");
    s.emit("contextmenu");
    await clock.tickAsync(20);
    assert.deepEqual(s.packets, []);
    s.remote_input.set_token(token);
    s.remote_input.set_token(token);
    s.emit("pointermove", {pointerType: "touch"});
    s.emit("pointermove", {clientX: 0});
    await clock.tickAsync(20);
    assert.deepEqual(s.packets, []);
    s.emit("pointermove", {clientX: 75});
    s.emit("pointermove", {clientX: 125});
    await clock.tickAsync(15);
    assert.deepEqual(s.packets, []);
    await clock.tickAsync(2);
    assert.deepEqual(s.packets, [{token, sequence: 1, event: {type: "move", x: 0.75, y: 0.5}}]);
    s.emit("pointermove");
    s.remote_input.set_token(undefined);
    await clock.tickAsync(20);
    assert.equal(s.packets.length, 1);
    s.remote_input.destroy();
    s.emit("pointermove");
    assert.equal(s.packets.length, 1);
});

run_test("clicks carry their coordinates and release outside the frame", async ({override}) => {
    const s = setup(override);
    s.remote_input.set_token(token);
    s.emit("pointerdown", {button: 4});
    s.emit("pointerdown", {pointerType: "touch"});
    s.emit("pointerdown", {clientX: 20});
    s.emit("pointerup", {button: 4});
    s.emit("pointerup");
    assert.deepEqual(s.packets, []);
    for (const [button, name] of [
        [0, "left"],
        [1, "middle"],
        [2, "right"],
    ]) {
        s.emit("pointermove");
        assert.equal(s.emit("pointerdown", {button, clientX: 75}), true);
        assert.equal(s.emit("pointerup", {button, clientX: 20}), true);
        assert.deepEqual(s.packets.at(-2).event, {
            type: "button",
            x: 0.25,
            y: 0.5,
            button: name,
            down: true,
        });
        assert.deepEqual(s.packets.at(-1).event, {
            type: "button",
            x: 0.25,
            y: 0.5,
            button: name,
            down: false,
        });
    }
    await clock.tickAsync(20);
    assert.equal(s.packets.length, 6, "pending motion does not move the cursor after a click");
    assert.equal(s.emit("contextmenu"), true);
    assert.equal(s.emit("dragstart"), true);
    s.emit("wheel", {deltaX: 1, deltaY: -3, deltaMode: 1});
    assert.equal(s.packets.length, 6);
    s.emit("pointerdown");
    assert.deepEqual(
        s.packets.slice(-2).map(({event}) => event),
        [
            {type: "wheel", x: 0.5, y: 0.5, dx: 40, dy: -120},
            {type: "button", x: 0.5, y: 0.5, button: "left", down: true},
        ],
        "scrolling reaches the screen before a later click",
    );
    s.emit("pointerup", {clientX: 125});
    assert.deepEqual(s.packets.at(-1).event, {
        type: "button",
        x: 0.75,
        y: 0.5,
        button: "left",
        down: false,
    });
    s.remote_input.destroy();
});

run_test("losing focus, capture, or the grant releases held buttons", ({override}) => {
    const s = setup(override);
    for (const end of [
        () => s.emit("pointercancel"),
        () => s.emit("lostpointercapture"),
        () => s.emit("pointerleave"),
        () => s.emit("pointermove", {clientX: 0}),
        () => s.emit("blur", {}, s.page_window),
        () => {
            s.page_document.hidden = true;
            s.emit("visibilitychange", {}, s.page_document);
        },
        () => s.remote_input.set_token(undefined),
        () => s.remote_input.destroy(),
    ]) {
        s.remote_input.set_token(token);
        s.emit("pointerdown");
        end();
        assert.deepEqual(s.packets.at(-1).event, {
            type: "button",
            x: 0.5,
            y: 0.5,
            button: "left",
            down: false,
        });
    }
});

run_test("scrolling is summed and sent with moves at most 60 times a second", async ({override}) => {
    const s = setup(override);
    s.remote_input.set_token(token);
    s.emit("pointermove", {clientX: 75});
    for (let i = 0; i < 10; i += 1) {
        s.emit("wheel", {deltaX: 0.7, deltaY: 100, deltaMode: 0});
    }
    s.emit("pointermove", {clientX: 125});
    await clock.tickAsync(17);
    assert.deepEqual(s.packets, [
        {token, sequence: 1, event: {type: "wheel", x: 0.5, y: 0.5, dx: 7, dy: 1000}},
    ]);
    await clock.tickAsync(17);
    assert.deepEqual(s.packets.at(-1), {
        token,
        sequence: 2,
        event: {type: "move", x: 0.75, y: 0.5},
    });

    // The sum is rounded and bounded, not each event.
    s.emit("wheel", {deltaX: 0.7, deltaY: -7000, deltaMode: 0});
    s.emit("wheel", {deltaX: 0.7, deltaY: -7000, deltaMode: 0});
    await clock.tickAsync(17);
    assert.deepEqual(s.packets.at(-1).event, {type: "wheel", x: 0.5, y: 0.5, dx: 1, dy: -12_000});
    s.emit("wheel", {deltaX: 0, deltaY: 1000, deltaMode: 1});
    await clock.tickAsync(17);
    assert.deepEqual(s.packets.at(-1).event, {type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 12_000});
    assert.equal(s.packets.length, 4);

    s.emit("wheel", {deltaX: 0, deltaY: 100, deltaMode: 0});
    s.remote_input.set_token(undefined);
    await clock.tickAsync(20);
    assert.equal(s.packets.length, 4, "scrolling is not sent after the grant ends");
    s.remote_input.destroy();
});

run_test("slow lossy sends do not queue old positions", async ({override}) => {
    const sent = [];
    let finish;
    const s = setup(override, async (_token, _sequence, event) => {
        sent.push(event);
        await new Promise((resolve) => {
            finish = resolve;
        });
    });
    s.remote_input.set_token(token);
    s.emit("pointermove");
    await clock.tickAsync(20);
    s.emit("pointermove", {clientX: 75});
    s.emit("pointermove", {clientX: 125});
    await clock.tickAsync(100);
    assert.equal(sent.length, 1);
    finish();
    await clock.tickAsync(20);
    assert.deepEqual(sent, [
        {type: "move", x: 0.5, y: 0.5},
        {type: "move", x: 0.75, y: 0.5},
    ]);
    finish();
    s.remote_input.destroy();
});

run_test(
    "failed button delivery stops local input and releases held buttons",
    async ({override}) => {
        const packets = [];
        const s = setup(override, async (_token, _sequence, event) => {
            packets.push(event);
            throw new Error("Disconnected");
        });
        s.remote_input.set_token(token);
        s.emit("pointerdown");
        await clock.tickAsync(1);
        assert.deepEqual(packets, [
            {type: "button", x: 0.5, y: 0.5, button: "left", down: true},
            {type: "button", x: 0.5, y: 0.5, button: "left", down: false},
        ]);
        s.emit("pointerdown");
        s.emit("pointermove");
        await clock.tickAsync(20);
        assert.equal(packets.length, 2);
        s.remote_input.destroy();
    },
);

run_test("a failed old send does not cancel a new grant", async ({override}) => {
    let fail;
    const packets = [];
    const s = setup(override, async (token, _sequence, event) => {
        packets.push({token, event});
        if (token === "a".repeat(32)) {
            await new Promise((_resolve, reject) => {
                fail = reject;
            });
        }
    });
    s.remote_input.set_token(token);
    s.emit("wheel", {deltaX: 0, deltaY: 120, deltaMode: 0});
    await clock.tickAsync(20);
    const new_token = "b".repeat(32);
    s.remote_input.set_token(new_token);
    fail(new Error("Old send failed"));
    await clock.tickAsync(1);
    s.emit("pointermove");
    await clock.tickAsync(20);
    assert.equal(packets.at(-1).token, new_token);
    assert.equal(packets.at(-1).event.type, "move");
    s.remote_input.destroy();
});

run_test("lossy failure can be followed by a newer move", async ({override}) => {
    const packets = [];
    const s = setup(override, async (_token, _sequence, event) => {
        packets.push(event);
        if (packets.length === 1) {
            throw new Error("Dropped move");
        }
    });
    s.remote_input.set_token(token);
    s.emit("pointermove");
    await clock.tickAsync(20);
    s.emit("pointermove", {clientX: 125});
    await clock.tickAsync(20);
    assert.deepEqual(packets, [
        {type: "move", x: 0.5, y: 0.5},
        {type: "move", x: 0.75, y: 0.5},
    ]);
    s.remote_input.destroy();
});

run_test("keys go to the shared screen while it has the focus", ({override}) => {
    const s = setup(override);
    assert.equal(s.emit("keydown", {code: "KeyA"}), false);
    s.remote_input.set_token(token);
    assert.equal(s.video.tabIndex, -1);
    assert.ok(!s.remote_input.keyboard_active);
    s.emit("pointerdown");
    s.emit("pointerup");
    assert.ok(s.remote_input.keyboard_active);
    assert.deepEqual(s.keyboard_states, [false, true]);
    assert.equal(s.emit("keydown", {code: "KeyA"}), true);
    assert.equal(s.emit("keydown", {code: "KeyA", repeat: true}), true);
    assert.equal(s.emit("keyup", {code: "KeyA"}), true);
    // Pressed before the keyboard went to the shared screen.
    assert.equal(s.emit("keyup", {code: "KeyB"}), true);
    // The Windows keys stay with the controller's computer.
    assert.equal(s.emit("keydown", {code: "MetaLeft"}), false);
    assert.equal(s.emit("keydown", {code: ""}), false);
    assert.deepEqual(
        s.packets.slice(2).map(({sequence, event}) => [sequence, event]),
        [
            [3, {type: "key", code: "KeyA", down: true}],
            [4, {type: "key", code: "KeyA", down: true}],
            [5, {type: "key", code: "KeyA", down: false}],
        ],
    );
    s.emit("keydown", {code: "ShiftLeft"});
    s.emit("blur");
    assert.deepEqual(s.packets.at(-1).event, {type: "key", code: "ShiftLeft", down: false});
    assert.ok(!s.remote_input.keyboard_active);
    assert.equal(s.keyboard_states.at(-1), false);
    s.remote_input.destroy();
});

run_test("losing the page or the grant releases held keys", ({override}) => {
    const s = setup(override);
    for (const end of [
        () => s.emit("blur", {}, s.page_window),
        () => {
            s.page_document.hidden = true;
            s.emit("visibilitychange", {}, s.page_document);
        },
        () => s.remote_input.set_token(undefined),
        () => s.remote_input.destroy(),
    ]) {
        s.remote_input.set_token(token);
        s.emit("keydown", {code: "ControlLeft"});
        end();
        assert.deepEqual(s.packets.at(-1).event, {type: "key", code: "ControlLeft", down: false});
    }
});

run_test("scrolling reaches the screen before a later key", ({override}) => {
    const s = setup(override);
    s.remote_input.set_token(token);
    s.emit("wheel", {deltaX: 0, deltaY: 100, deltaMode: 0});
    s.emit("keydown", {code: "PageDown"});
    assert.deepEqual(
        s.packets.map(({event}) => event.type),
        ["wheel", "key"],
    );
    s.remote_input.destroy();
});
