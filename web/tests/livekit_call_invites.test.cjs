"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {RING_TIMEOUT_SECONDS, get_call_chat_hash, get_invited_users} =
    zrequire("livekit_call_invites");

function ring(user_id, date_rang, answer = null) {
    return {user_id, caller_id: 1, date_rang, answer};
}

run_test("get_invited_users", () => {
    const now = 1000;
    const rings = [
        ring(2, now - 10),
        ring(3, now - 10, "decline"),
        ring(4, now - RING_TIMEOUT_SECONDS),
        ring(5, now - 10, "cancel"),
        ring(6, now - 10, "accept"),
        ring(7, now - 10),
        // Calling someone again replaces how the earlier call went.
        ring(3, now - 5),
        ring(4, now - 100, "accept"),
    ];
    assert.deepEqual(get_invited_users(rings, new Set([7]), now), [
        {user_id: 2, status: "calling"},
        {user_id: 3, status: "calling"},
        {user_id: 4, status: "missed"},
        {user_id: 5, status: "missed"},
        {user_id: 6, status: "calling"},
    ]);
    assert.deepEqual(get_invited_users([ring(3, now - 10, "decline")], new Set(), now), [
        {user_id: 3, status: "declined"},
    ]);
    assert.deepEqual(get_invited_users([], new Set(), now), []);
});

run_test("get_call_chat_hash", () => {
    assert.equal(get_call_chat_hash({message_id: 1, user_ids: [8, 10, 12]}), "#narrow/dm/8,10,12");
    assert.equal(
        get_call_chat_hash({message_id: 1, stream_id: 5, topic: "daily standup"}),
        "#narrow/channel/5/topic/daily.20standup",
    );
});
