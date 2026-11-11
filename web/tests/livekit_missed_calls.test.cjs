"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const channel = mock_esm("../src/channel");

const {Filter} = zrequire("../src/filter");
const livekit_missed_calls = zrequire("livekit_missed_calls");
const people = zrequire("people");
const {set_current_user, set_realm} = zrequire("state_data");

const me = make_user({user_id: 1, full_name: "Me Myself"});
const alice = make_user({user_id: 2, full_name: "Alice"});
const bob = make_user({user_id: 3, full_name: "Bob"});
for (const user of [me, alice, bob]) {
    people.add_active_user(user);
    people.add_valid_user_id(user.user_id);
}
people.initialize_current_user(me.user_id);
set_current_user({user_id: me.user_id});

const dm_call = {
    caller_id: alice.user_id,
    date_rang: 1000,
    seen: false,
    conversation: {message_id: 10, user_ids: [alice.user_id, me.user_id]},
};
const group_call = {
    caller_id: bob.user_id,
    date_rang: 2000,
    seen: true,
    conversation: {message_id: 20, user_ids: [bob.user_id, alice.user_id, me.user_id]},
};
const channel_call = {
    caller_id: bob.user_id,
    date_rang: 3000,
    seen: false,
    conversation: {message_id: 30, stream_id: 5, topic: "Standup"},
};

function filter(raw_terms) {
    return new Filter(raw_terms.map(([operator, operand]) => ({operator, operand})));
}

function initialize({override}, missed_calls) {
    let changes = 0;
    override(channel, "get", (opts) => {
        assert.equal(opts.url, "/json/calls/livekit/missed");
        opts.success({result: "success", msg: "", missed_calls});
    });
    livekit_missed_calls.initialize({
        on_change() {
            changes += 1;
        },
    });
    return () => changes;
}

run_test("is_available", () => {
    set_realm(make_realm({realm_available_video_chat_providers: {disabled: {name: "", id: 0}}}));
    assert.ok(!livekit_missed_calls.is_available());

    set_realm(
        make_realm({
            realm_available_video_chat_providers: {
                disabled: {name: "", id: 0},
                livekit: {name: "LiveKit", id: 7},
            },
        }),
    );
    assert.ok(livekit_missed_calls.is_available());
    page_params.is_spectator = true;
    assert.ok(!livekit_missed_calls.is_available());
    page_params.is_spectator = false;
});

run_test("get_conversation_key", () => {
    assert.equal(livekit_missed_calls.get_conversation_key(dm_call.conversation), "2");
    assert.equal(livekit_missed_calls.get_conversation_key(group_call.conversation), "2,3");
    assert.equal(livekit_missed_calls.get_conversation_key(channel_call.conversation), "5:standup");
    assert.equal(
        livekit_missed_calls.get_conversation_key({message_id: 1, user_ids: [me.user_id]}),
        "1",
    );
});

run_test("counts", (helpers) => {
    const changes = initialize(helpers, [
        structuredClone(channel_call),
        structuredClone(group_call),
        structuredClone(dm_call),
    ]);
    assert.equal(changes(), 1);
    assert.equal(livekit_missed_calls.get_unseen_count(), 2);
    assert.deepEqual(livekit_missed_calls.get_counts("2"), {count: 1, unseen_count: 1});
    assert.deepEqual(livekit_missed_calls.get_counts("2,3"), {count: 1, unseen_count: 0});
    assert.deepEqual(livekit_missed_calls.get_counts("4"), {count: 0, unseen_count: 0});

    livekit_missed_calls.add(structuredClone({...dm_call, date_rang: 4000}));
    assert.equal(changes(), 2);
    assert.deepEqual(livekit_missed_calls.get_counts("2"), {count: 2, unseen_count: 2});

    // Another device opened the conversation.
    livekit_missed_calls.mark_seen([dm_call.conversation.message_id]);
    assert.equal(changes(), 3);
    assert.deepEqual(livekit_missed_calls.get_counts("2"), {count: 2, unseen_count: 0});
    assert.equal(livekit_missed_calls.get_unseen_count(), 1);
});

run_test("handle_narrow_activated", (helpers) => {
    const changes = initialize(helpers, [
        structuredClone(channel_call),
        structuredClone(group_call),
        structuredClone(dm_call),
    ]);
    const posts = [];
    helpers.override(channel, "post", (opts) => {
        posts.push(opts);
    });

    // Conversations without unseen missed calls change nothing.
    for (const terms of [
        [["channel", "5"]],
        [
            ["channel", "5"],
            ["topic", "other"],
        ],
        [["dm", [alice.user_id, bob.user_id]]],
        [["is", "starred"]],
    ]) {
        livekit_missed_calls.handle_narrow_activated(filter(terms));
    }
    assert.equal(changes(), 1);
    assert.deepEqual(posts, []);

    livekit_missed_calls.handle_narrow_activated(
        filter([
            ["channel", "5"],
            ["topic", "standup"],
        ]),
    );
    assert.equal(changes(), 2);
    assert.deepEqual(livekit_missed_calls.get_counts("5:standup"), {count: 1, unseen_count: 0});
    assert.deepEqual(posts, [
        {url: "/json/calls/livekit/missed/seen", data: {message_ids: "[30]"}},
    ]);

    livekit_missed_calls.handle_narrow_activated(filter([["dm", [alice.user_id]]]));
    assert.equal(livekit_missed_calls.get_unseen_count(), 0);
    assert.deepEqual(posts.at(-1).data, {message_ids: "[10]"});
});
