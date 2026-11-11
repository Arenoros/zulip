"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {$} = require("./lib/zjquery.cjs");

const banners = mock_esm("../src/banners");
const channel = mock_esm("../src/channel");
const compose_banner = mock_esm("../src/compose_banner", {
    CLASSNAMES: {
        missing_stream: "missing_stream",
        generic_compose_error: "generic_compose_error",
    },
});
const compose_state = mock_esm("../src/compose_state");
const compose_validate = mock_esm("../src/compose_validate", {
    NO_CHANNEL_SELECTED_ERROR_MESSAGE: "Please select a channel.",
});
const popup_banners = mock_esm("../src/popup_banners");
const ui_util = mock_esm("../src/ui_util");

let next_timer_id = 1;
const timeouts = new Map();
const intervals = new Map();
set_global("setTimeout", (f, delay) => {
    const timer_id = next_timer_id;
    next_timer_id += 1;
    timeouts.set(timer_id, {f, delay});
    return timer_id;
});
set_global("clearTimeout", (timer_id) => {
    timeouts.delete(timer_id);
});
set_global("setInterval", (f, delay) => {
    const timer_id = next_timer_id;
    next_timer_id += 1;
    intervals.set(timer_id, {f, delay});
    return timer_id;
});
set_global("clearInterval", (timer_id) => {
    intervals.delete(timer_id);
});

function run_timeouts(delay) {
    for (const [timer_id, timeout] of timeouts) {
        if (timeout.delay === delay) {
            timeouts.delete(timer_id);
            timeout.f();
        }
    }
}

const call_ringing = zrequire("call_ringing");
const livekit_missed_calls = zrequire("livekit_missed_calls");
const people = zrequire("people");
const {set_current_user} = zrequire("state_data");
const {initialize_user_settings} = zrequire("user_settings");

const me = make_user({user_id: 1, full_name: "Me Myself"});
const alice = make_user({user_id: 2, full_name: "Alice"});
const bob = make_user({user_id: 3, full_name: "Bob"});
const bot = make_user({user_id: 4, full_name: "Bot", is_bot: true});
for (const user of [me, alice, bob, bot]) {
    people.add_active_user(user);
}
people.initialize_current_user(me.user_id);
set_current_user({user_id: me.user_id});
const user_settings = {enable_sounds: true};
initialize_user_settings({user_settings});

const RING_SOUND_INTERVAL_MS = 3000;
const RESULT_BANNER_DURATION_MS = 5000;

let banner_count = 0;
let $last_banner;
let opened_urls;
let posts;
let faded_banners;

function test(label, f) {
    run_test(label, (helpers) => {
        timeouts.clear();
        intervals.clear();
        opened_urls = [];
        posts = [];
        faded_banners = [];
        window.open = (url, target, features) => {
            assert.equal(target, "_blank");
            assert.equal(features, "noopener,noreferrer");
            opened_urls.push(url);
        };
        helpers.override(
            channel,
            "post",
            (opts) => {
                posts.push(opts);
            },
            {unused: false},
        );
        helpers.override(
            popup_banners,
            "fade_out_popup_banner",
            ($banner) => {
                faded_banners.push($banner);
            },
            {unused: false},
        );
        helpers.override(
            banners,
            "append",
            (banner) => {
            banner_count += 1;
            const $banner = $.create(`call-banner-${banner_count}`);
            $banner.banner = banner;
            $banner.$label = $.create(`call-banner-label-${banner_count}`);
            $banner.$buttons = $.create(`call-banner-buttons-${banner_count}`);
            $banner.set_find_results(".banner-label", $banner.$label);
            $banner.set_find_results(".banner-action-buttons", $banner.$buttons);
            $last_banner = $banner;
            return $banner;
            },
            {unused: false},
        );
        call_ringing.initialize();
        f(helpers);
    });
}

function click(selector, $banner) {
    const $button = $.create(`${selector}-${banner_count}-${faded_banners.length}`);
    $button.set_closest_results(".banner", $banner);
    $("#popup_banners_wrapper")
        .get_on_handler("click", selector)
        .call({to_$: () => $button});
}

function start_direct_message_call({override}, recipient_ids, message_id) {
    override(compose_state, "get_message_type", () => "private");
    override(compose_validate, "validate_private_message", () => true);
    override(compose_state, "private_message_recipient_ids", () => recipient_ids);
    call_ringing.start_call_from_compose(123456789012345, false);
    posts.at(-1).success({message_id, result: "success", msg: ""});
    return $last_banner;
}

function ring(message_id, voice_only = false) {
    call_ringing.dispatch({
        op: "ring",
        message_id,
        caller_id: alice.user_id,
        url: `/calls/livekit/join?call_id=${message_id}`,
        voice_only,
        conversation: {message_id, user_ids: [me.user_id, alice.user_id]},
    });
}

test("get_call_url", () => {
    assert.equal(call_ringing.get_call_url(123, false), "/calls/livekit/join?call_id=123");
    assert.equal(
        call_ringing.get_call_url(123, true),
        "/calls/livekit/join?call_id=123&voice_only=true",
    );
    assert.equal(
        call_ringing.get_call_url(123, true, {dm_user_ids: [3, 1, 2, 1]}),
        "/calls/livekit/join?call_id=123&dm=1,2,3&voice_only=true",
    );
    assert.equal(
        call_ringing.get_call_url(123, false, {channel_id: 5}),
        "/calls/livekit/join?call_id=123&channel_id=5",
    );
});

test("start channel call", ({override, disallow}) => {
    override(compose_state, "get_message_type", () => "stream");
    override(compose_state, "stream_id", () => undefined);
    let error;
    override(compose_banner, "show_error_message", (...args) => {
        error = args;
    });
    call_ringing.start_call_from_compose(123, false);
    assert.deepEqual(error.slice(0, 2), ["Please select a channel.", "missing_stream"]);
    assert.deepEqual(opened_urls, []);
    assert.deepEqual(posts, []);

    override(compose_state, "stream_id", () => 5);
    override(compose_state, "topic", () => "standup");
    call_ringing.start_call_from_compose(123, true);
    assert.deepEqual(opened_urls, [
        "/calls/livekit/join?call_id=123&channel_id=5&voice_only=true",
    ]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/json/calls/livekit/start");
    assert.deepEqual(posts[0].data, {
        type: "channel",
        channel_id: "5",
        topic: "standup",
        call_id: "123",
        voice_only: "true",
    });

    // Calls in channels don't ring anyone.
    disallow(banners, "append");
    posts[0].success({message_id: 42, result: "success", msg: ""});
});

test("start direct message call errors", ({override}) => {
    override(compose_state, "get_message_type", () => "private");
    override(compose_validate, "validate_private_message", () => false);
    call_ringing.start_call_from_compose(123, false);
    assert.deepEqual(opened_urls, []);
    assert.deepEqual(posts, []);

    override(compose_validate, "validate_private_message", () => true);
    override(compose_state, "private_message_recipient_ids", () => [alice.user_id]);
    call_ringing.start_call_from_compose(123, false);
    assert.deepEqual(opened_urls, ["/calls/livekit/join?call_id=123&dm=1,2"]);

    const xhr = {responseJSON: {msg: "Invalid user ID 9999"}};
    override(channel, "xhr_error_message", (message, error_xhr) => {
        assert.equal(error_xhr, xhr);
        return `${message}: ${error_xhr.responseJSON.msg}`;
    });
    let error;
    override(compose_banner, "show_error_message", (...args) => {
        error = args;
    });
    posts[0].error(xhr);
    assert.deepEqual(error.slice(0, 2), [
        "translated: Failed to start the call.: Invalid user ID 9999",
        "generic_compose_error",
    ]);
});

test("outgoing call is accepted", (helpers) => {
    const $banner = start_direct_message_call(
        helpers,
        [me.user_id, alice.user_id, bot.user_id],
        42,
    );
    assert.deepEqual(posts[0].data, {
        type: "direct",
        to: JSON.stringify([me.user_id, alice.user_id, bot.user_id]),
        call_id: "123456789012345",
        voice_only: "false",
    });
    assert.equal($banner.banner.label, "translated: Calling Alice…");
    assert.equal($banner.attr("data-message-id"), "42");

    // Answers to other calls are ignored.
    call_ringing.dispatch({op: "accept", message_id: 99, user_id: alice.user_id});
    assert.deepEqual(faded_banners, []);

    call_ringing.dispatch({op: "accept", message_id: 42, user_id: alice.user_id});
    assert.deepEqual(faded_banners, [$banner]);
    assert.equal(timeouts.size, 0);
});

test("outgoing call is declined", (helpers) => {
    const $banner = start_direct_message_call(helpers, [alice.user_id, bob.user_id], 43);
    assert.equal($banner.banner.label, "translated: Calling Alice and Bob…");
    const initial_label = $banner.$label.text();

    call_ringing.dispatch({op: "decline", message_id: 43, user_id: bob.user_id});
    assert.equal($banner.$label.text(), initial_label);

    call_ringing.dispatch({op: "decline", message_id: 43, user_id: alice.user_id});
    assert.equal($banner.$label.text(), "translated: Bob and Alice declined the call.");
    assert.ok(!$banner.$buttons.visible());
    assert.deepEqual(faded_banners, []);
    run_timeouts(RESULT_BANNER_DURATION_MS);
    assert.deepEqual(faded_banners, [$banner]);
});

test("outgoing call is not answered", (helpers) => {
    const $banner = start_direct_message_call(helpers, [alice.user_id, bob.user_id], 44);
    call_ringing.dispatch({op: "decline", message_id: 44, user_id: bob.user_id});

    run_timeouts(call_ringing.RING_TIMEOUT_MS);
    assert.deepEqual(posts.at(-1).data, {message_id: "44", op: "cancel"});
    assert.equal($banner.$label.text(), "translated: Alice didn't answer.");
    run_timeouts(RESULT_BANNER_DURATION_MS);
    assert.deepEqual(faded_banners, [$banner]);
});

test("outgoing call is cancelled", (helpers) => {
    const $banner = start_direct_message_call(helpers, [alice.user_id], 45);
    click(".outgoing-call-cancel", $banner);
    assert.equal(posts.at(-1).url, "/json/calls/livekit/ring");
    assert.deepEqual(posts.at(-1).data, {message_id: "45", op: "cancel"});
    assert.deepEqual(faded_banners, [$banner]);
    assert.equal(timeouts.size, 0);

    // A second click on a banner that is fading out only repeats the
    // harmless cancel request.
    click(".outgoing-call-cancel", $banner);
    assert.deepEqual(faded_banners, [$banner]);
});

test("call windows' events are ignored", (helpers) => {
    const $banner = start_direct_message_call(helpers, [alice.user_id], 47);
    call_ringing.dispatch({op: "rings", message_id: 47, rings: []});
    assert.deepEqual(faded_banners, []);
    assert.equal($banner.banner.label, "translated: Calling Alice…");
});

test("outgoing call ends", (helpers) => {
    const $banner = start_direct_message_call(helpers, [alice.user_id], 46);
    call_ringing.dispatch({op: "cancel", message_id: 46});
    assert.deepEqual(faded_banners, [$banner]);
    assert.equal(timeouts.size, 0);
});

test("incoming call is accepted", ({override}) => {
    let played_sounds = 0;
    override(ui_util, "play_audio", () => {
        played_sounds += 1;
    });

    ring(50);
    const $banner = $last_banner;
    assert.equal($banner.banner.label, "translated: Alice is calling you (video call).");
    assert.equal($banner.attr("data-message-id"), "50");

    // A repeated event doesn't ring twice.
    ring(50);
    assert.equal(intervals.size, 1);

    const [interval] = intervals.values();
    assert.equal(interval.delay, RING_SOUND_INTERVAL_MS);
    interval.f();
    assert.equal(played_sounds, 1);
    user_settings.enable_sounds = false;
    interval.f();
    assert.equal(played_sounds, 1);
    user_settings.enable_sounds = true;

    click(".incoming-call-accept", $banner);
    assert.deepEqual(opened_urls, ["/calls/livekit/join?call_id=50"]);
    assert.deepEqual(posts.at(-1).data, {message_id: "50", op: "accept"});
    assert.deepEqual(faded_banners, [$banner]);
    assert.equal(timeouts.size, 0);
    assert.equal(intervals.size, 0);

    // A second click on a banner that is fading out does nothing.
    click(".incoming-call-accept", $banner);
    assert.equal(opened_urls.length, 1);
});

test("incoming call is declined", () => {
    ring(51, true);
    const $banner = $last_banner;
    assert.equal($banner.banner.label, "translated: Alice is calling you (voice call).");
    click(".incoming-call-decline", $banner);
    assert.deepEqual(opened_urls, []);
    assert.deepEqual(posts.at(-1).data, {message_id: "51", op: "decline"});
    assert.deepEqual(faded_banners, [$banner]);
});

test("incoming call stops ringing", () => {
    const missed_calls = livekit_missed_calls.get_counts(`${alice.user_id}`).count;

    ring(52);
    const $answered_banner = $last_banner;
    call_ringing.dispatch({op: "accept", message_id: 52, user_id: me.user_id});
    assert.deepEqual(faded_banners, [$answered_banner]);

    ring(53);
    const $cancelled_banner = $last_banner;
    call_ringing.dispatch({op: "cancel", message_id: 53});
    assert.deepEqual(faded_banners, [$answered_banner, $cancelled_banner]);

    ring(54);
    const $missed_banner = $last_banner;
    run_timeouts(call_ringing.RING_TIMEOUT_MS);
    assert.deepEqual(faded_banners, [$answered_banner, $cancelled_banner, $missed_banner]);
    assert.equal(intervals.size, 0);

    // Events for calls that already stopped ringing are ignored.
    call_ringing.dispatch({op: "cancel", message_id: 54});
    assert.equal(faded_banners.length, 3);

    // The cancelled call and the one that timed out were missed.
    assert.deepEqual(livekit_missed_calls.get_counts(`${alice.user_id}`), {
        count: missed_calls + 2,
        unseen_count: 2,
    });
    call_ringing.dispatch({op: "missed_seen", message_ids: [53, 54]});
    assert.equal(livekit_missed_calls.get_unseen_count(), 0);
});

