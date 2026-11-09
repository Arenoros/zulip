"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const electron_bridge = mock_esm("../src/electron_bridge");

const livekit_remote_control = zrequire("livekit_remote_control");

const cordelia = {identity: "8", name: "Cordelia"};
const hamlet = {identity: "10", name: "King Hamlet"};

run_test("screen share from a desktop app supporting remote control", ({override}) => {
    override(electron_bridge, "electron_bridge", {get_remote_control_supported: () => true});
    const publish_options = livekit_remote_control.get_screen_share_publish_options();
    assert.ok(
        livekit_remote_control.is_controllable_screen_share({trackName: publish_options.name}),
    );
});

run_test("screen share from a browser", ({override}) => {
    override(electron_bridge, "electron_bridge", undefined);
    assert.deepEqual(livekit_remote_control.get_screen_share_publish_options(), {});
});

run_test("screen share from an older desktop app", ({override}) => {
    override(electron_bridge, "electron_bridge", {});
    assert.deepEqual(livekit_remote_control.get_screen_share_publish_options(), {});
});

run_test("screen share from a desktop app not supporting remote control", ({override}) => {
    override(electron_bridge, "electron_bridge", {get_remote_control_supported: () => false});
    assert.deepEqual(livekit_remote_control.get_screen_share_publish_options(), {});
});

run_test("is_controllable_screen_share", () => {
    // Browsers publish screen shares without a track name.
    assert.ok(!livekit_remote_control.is_controllable_screen_share({trackName: ""}));
    assert.ok(!livekit_remote_control.is_controllable_screen_share({trackName: "screen"}));
});

run_test("messages", () => {
    for (const message of [
        {type: "request"},
        {type: "release"},
        {type: "state", control_state: {state: "shared"}},
        {type: "state", control_state: {state: "requested", participant: cordelia}},
        {type: "state", control_state: {state: "controlled", participant: hamlet}},
    ]) {
        assert.deepEqual(
            livekit_remote_control.decode_message(livekit_remote_control.encode_message(message)),
            {version: 1, ...message},
        );
    }

    const encode = (data) => new TextEncoder().encode(JSON.stringify(data));
    for (const data of [
        {version: 2, type: "request"},
        {type: "request"},
        {version: 1, type: "grant"},
        {version: 1, type: "state", control_state: {state: "controlled"}},
        {version: 1, type: "state", control_state: {state: "taken", participant: cordelia}},
    ]) {
        assert.equal(livekit_remote_control.decode_message(encode(data)), undefined);
    }
    assert.equal(
        livekit_remote_control.decode_message(new TextEncoder().encode("not JSON")),
        undefined,
    );
});

run_test("parse_control_state", () => {
    // The controller's token stays with the owner's call page.
    assert.deepEqual(
        livekit_remote_control.parse_control_state({
            state: "controlled",
            participant: cordelia,
            token: "secret",
        }),
        {state: "controlled", participant: cordelia},
    );
    assert.deepEqual(livekit_remote_control.parse_control_state({state: "none"}), {
        state: "none",
    });
    assert.equal(livekit_remote_control.parse_control_state({state: "requested"}), undefined);
    assert.equal(livekit_remote_control.parse_control_state(undefined), undefined);
});

run_test("private grants and mouse messages", () => {
    const token = "a".repeat(32);
    for (const message of [
        {type: "grant", token},
        {type: "mouse", token, sequence: 1, event: {type: "move", x: 0.5, y: 1}},
        {
            type: "mouse",
            token,
            sequence: 2,
            event: {type: "button", x: 0, y: 0, button: "right", down: true},
        },
        {type: "mouse", token, sequence: 3, event: {type: "wheel", x: 1, y: 0, dx: 120, dy: -240}},
        {type: "key", token, sequence: 4, code: "KeyA", down: true},
    ]) {
        assert.deepEqual(
            livekit_remote_control.decode_message(livekit_remote_control.encode_message(message)),
            {version: 1, ...message},
        );
    }
    const state = {state: "controlled", participant: cordelia, token};
    assert.equal(livekit_remote_control.parse_control_token(state), token);
    assert.equal(livekit_remote_control.parse_control_token({state: "shared", token}), undefined);
    assert.equal(livekit_remote_control.parse_control_token({...state, token: ""}), undefined);
    assert.deepEqual(
        livekit_remote_control.decode_message(
            livekit_remote_control.encode_message({type: "state", control_state: state}),
        ),
        {
            version: 1,
            type: "state",
            control_state: {state: "controlled", participant: cordelia},
        },
    );
    assert.equal(livekit_remote_control.decode_message(new Uint8Array(4097)), undefined);
    for (const event of [
        {type: "move", x: -0.1, y: 0},
        {type: "move", x: 0, y: 1.1},
        {type: "button", x: 0, y: 0, button: "back", down: true},
        {type: "wheel", x: 0, y: 0, dx: 0, dy: 12_001},
    ]) {
        const bytes = new TextEncoder().encode(
            JSON.stringify({version: 1, type: "mouse", token, sequence: 1, event}),
        );
        assert.equal(livekit_remote_control.decode_message(bytes), undefined);
    }
    for (const key of [
        {code: "K".repeat(33), down: true},
        {code: "KeyA", down: "yes"},
    ]) {
        const bytes = new TextEncoder().encode(
            JSON.stringify({version: 1, type: "key", token, sequence: 1, ...key}),
        );
        assert.equal(livekit_remote_control.decode_message(bytes), undefined);
    }
});

run_test("describe_control_state for the owner", () => {
    function describe(control_state) {
        return livekit_remote_control.describe_control_state({
            control_state,
            owner_name: "Desdemona",
            is_own_share: true,
            local_identity: "9",
            keyboard_active: false,
        });
    }

    for (const control_state of [undefined, {state: "none"}, {state: "shared"}]) {
        assert.deepEqual(describe(control_state), {
            label: "translated: Remote control available",
            action: undefined,
        });
    }
    assert.deepEqual(describe({state: "requested", participant: cordelia}), {
        label: "translated: Cordelia requested control",
        action: undefined,
    });
    assert.deepEqual(describe({state: "controlled", participant: cordelia}), {
        label: "translated: Cordelia is controlling your screen",
        action: {type: "stop", label: "translated: Stop control"},
    });
});

run_test("describe_control_state for other participants", () => {
    function describe(control_state, local_identity, keyboard_active = false) {
        return livekit_remote_control.describe_control_state({
            control_state,
            owner_name: "Desdemona",
            is_own_share: false,
            local_identity,
            keyboard_active,
        });
    }

    assert.deepEqual(describe({state: "shared"}, cordelia.identity), {
        label: "translated: Remote control available",
        action: {type: "request", label: "translated: Request control"},
    });
    assert.deepEqual(describe({state: "requested", participant: cordelia}, cordelia.identity), {
        label: "translated: Waiting for Desdemona to allow control…",
        action: undefined,
    });
    assert.deepEqual(describe({state: "requested", participant: cordelia}, hamlet.identity), {
        label: "translated: Cordelia requested control",
        action: undefined,
    });
    assert.deepEqual(describe({state: "controlled", participant: cordelia}, cordelia.identity), {
        label: "translated: You are controlling this screen. Click it to type.",
        action: {type: "release", label: "translated: Stop controlling"},
    });
    assert.deepEqual(
        describe({state: "controlled", participant: cordelia}, cordelia.identity, true),
        {
            label: "translated: Your keyboard controls this screen. Click outside it to stop.",
            action: {type: "release", label: "translated: Stop controlling"},
        },
    );
    assert.deepEqual(describe({state: "controlled", participant: cordelia}, hamlet.identity), {
        label: "translated: Cordelia is controlling this screen",
        action: undefined,
    });
});
