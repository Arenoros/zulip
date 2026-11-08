"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const electron_bridge = mock_esm("../src/electron_bridge");

const livekit_remote_control = zrequire("livekit_remote_control");

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
