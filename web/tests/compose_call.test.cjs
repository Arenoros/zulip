"use strict";

const assert = require("node:assert/strict");

const events = require("./lib/events.cjs");
const {make_realm} = require("./lib/example_realm.cjs");
const {make_stream} = require("./lib/example_stream.cjs");
const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {$} = require("./lib/zjquery.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const channel = mock_esm("../src/channel");
const compose_state = mock_esm("../src/compose_state");
const compose_ui = mock_esm("../src/compose_ui");
const message_store = mock_esm("../src/message_store");

const server_events_dispatch = zrequire("server_events_dispatch");
const compose_call = zrequire("compose_call");
const compose_call_ui = zrequire("compose_call_ui");
const people = zrequire("people");
const stream_data = zrequire("stream_data");
const {set_current_user, set_realm} = zrequire("state_data");

const realm = make_realm();
set_realm(realm);
const current_user = make_user({
    email: "alice@zulip.com",
    user_id: 1,
    full_name: "Alice",
});
set_current_user(current_user);
people.add_active_user(current_user);
people.add_active_user(
    make_user({
        email: "bob@zulip.com",
        user_id: 2,
        full_name: "Bob",
    }),
);
people.initialize_current_user(current_user.user_id);

const realm_available_video_chat_providers = {
    disabled: {
        id: 0,
        name: "disabled",
    },
    jitsi_meet: {
        id: 1,
        name: "Jitsi Meet",
    },
    zoom: {
        id: 3,
        name: "Zoom",
    },
    big_blue_button: {
        id: 4,
        name: "BigBlueButton",
    },
    constructor_groups: {
        id: 6,
        name: "Constructor Groups",
    },
    nextcloud_talk: {
        id: 7,
        name: "Nextcloud Talk",
    },
    webex: {
        id: 8,
        name: "Webex",
    },
    google_meet: {
        id: 9,
        name: "Google Meet",
    },
    livekit: {
        id: 10,
        name: "LiveKit",
    },
};

function test(label, f) {
    run_test(label, (helpers) => {
        helpers.override(
            realm,
            "realm_available_video_chat_providers",
            realm_available_video_chat_providers,
        );
        f(helpers);
    });
}

test("videos", ({override, override_rewire}) => {
    (function test_jitsi_video_link_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("jitsi-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
        });

        $("textarea#compose-textarea").val("");

        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.jitsi_meet.id,
        );

        override(realm, "realm_jitsi_server_url", null);
        override(realm, "server_jitsi_server_url", "https://server.example.com");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        // video link ids consist of 15 random digits
        let video_link_regex =
            /\[translated: Join video call\.]\(https:\/\/server.example.com\/\d{15}#config.startWithVideoMuted=false\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);

        override(realm, "realm_jitsi_server_url", "https://realm.example.com");
        override(realm, "server_jitsi_server_url", null);
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        video_link_regex =
            /\[translated: Join video call\.]\(https:\/\/realm.example.com\/\d{15}#config.startWithVideoMuted=false\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);

        override(realm, "realm_jitsi_server_url", "https://realm.example.com");
        override(realm, "server_jitsi_server_url", "https://server.example.com");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        video_link_regex =
            /\[translated: Join video call\.]\(https:\/\/realm.example.com\/\d{15}#config.startWithVideoMuted=false\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);

        // Scenario where the URL has a path segment (like an auth token)
        override(realm, "realm_jitsi_server_url", "https://jitsi.example.com/custom-token");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);

        video_link_regex =
            /\[translated: Join video call\.\]\(https:\/\/jitsi\.example\.com\/custom-token\/\d{15}#config\.startWithVideoMuted=false\)/;

        assert.match(syntax_to_insert, video_link_regex);
    })();

    (function test_zoom_video_and_audio_links_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("zoom-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
            success_callback = undefined;
        });

        override(realm, "realm_video_chat_provider", realm_available_video_chat_providers.zoom.id);
        override(current_user, "has_zoom_token", false);

        window.open = (url) => {
            assert.ok(url.endsWith("/calls/zoom/register"));

            // The event here has value=true.  We keep it in events.js to
            // allow our tooling to verify its schema.
            server_events_dispatch.dispatch_normal_event(events.fixtures.has_zoom_token);
        };

        let success_callback;
        const xhr_object = {abort() {}};
        channel.post = (payload) => {
            assert.equal(payload.url, "/json/calls/zoom/create");
            success_callback = payload.success;
            return xhr_object;
        };

        function call_success_callback() {
            assert.ok(success_callback !== undefined);
            success_callback({
                result: "success",
                msg: "",
                url: "example.zoom.com",
            });
        }

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        call_success_callback();
        const video_link_regex = /\[translated: Join video call\.]\(example\.zoom\.com\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, true);
        call_success_callback();
        const audio_link_regex = /\[translated: Join voice call\.]\(example\.zoom\.com\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, audio_link_regex);
    })();

    (function test_webex_video_link_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("webex-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
            success_callback = undefined;
        });

        override(realm, "realm_video_chat_provider", realm_available_video_chat_providers.webex.id);
        override(current_user, "has_webex_token", false);

        window.open = (url) => {
            assert.ok(url.endsWith("/calls/webex/register"));

            // The event here has value=true.  We keep it in events.js to
            // allow our tooling to verify its schema.
            server_events_dispatch.dispatch_normal_event(events.fixtures.has_webex_token);
        };

        let success_callback;
        const xhr_object = {abort() {}};
        channel.post = (payload) => {
            assert.equal(payload.url, "/json/calls/webex/create");
            success_callback = payload.success;
            return xhr_object;
        };

        function call_success_callback() {
            assert.ok(success_callback !== undefined);
            success_callback({
                result: "success",
                msg: "",
                url: "example.webex.com",
            });
        }

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        call_success_callback();
        const video_link_regex = /\[translated: Join video call\.]\(example\.webex\.com\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);
    })();

    (function test_google_meet_video_link_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("google-meet-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
            success_callback = undefined;
        });

        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.google_meet.id,
        );
        override(current_user, "has_google_meet_token", false);

        window.open = (url) => {
            assert.ok(url.endsWith("/calls/google_meet/register"));

            // The event here has value=true.  We keep it in events.js to
            // allow our tooling to verify its schema.
            server_events_dispatch.dispatch_normal_event(events.fixtures.has_google_meet_token);
        };

        let success_callback;
        const xhr_object = {abort() {}};
        channel.post = (payload) => {
            assert.equal(payload.url, "/json/calls/google_meet/create");
            success_callback = payload.success;
            return xhr_object;
        };

        function call_success_callback() {
            assert.ok(success_callback !== undefined);
            success_callback({
                result: "success",
                msg: "",
                url: "https://meet.google.com/abc-mnop-xyz",
            });
        }

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        call_success_callback();
        const video_link_regex =
            /\[translated: Join video call\.]\(https:\/\/meet\.google\.com\/abc-mnop-xyz\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);
    })();

    (function test_bbb_audio_and_video_links_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("bbb-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
            success_callback = undefined;
            url = undefined;
        });

        $("textarea#compose-textarea").val("");

        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.big_blue_button.id,
        );

        override_rewire(compose_call_ui, "get_recipient_label_for_call", () => ({
            label_text: "a",
        }));

        let success_callback;
        const xhr_object = {abort() {}};
        let url;
        channel.get = (options) => {
            assert.equal(options.url, "/json/calls/bigbluebutton/create");
            assert.equal(options.data.meeting_name, "a meeting");
            success_callback = options.success;
            url =
                "/calls/bigbluebutton/join?meeting_id=%22zulip-1%22&moderator=%22AAAAAAAAAA%22&lock_settings_disable_cam=" +
                options.data.voice_only +
                "&checksum=%2232702220bff2a22a44aee72e96cfdb4c4091752e%22";
            return xhr_object;
        };

        function call_success_callback() {
            assert.ok(success_callback !== undefined);
            success_callback({
                result: "success",
                msg: "",
                url,
            });
        }

        $("textarea#compose-textarea").val("");

        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        call_success_callback();
        const video_link_regex =
            /\[translated: Join video call\.]\(\/calls\/bigbluebutton\/join\?meeting_id=%22zulip-1%22&moderator=%22AAAAAAAAAA%22&lock_settings_disable_cam=false&checksum=%2232702220bff2a22a44aee72e96cfdb4c4091752e%22\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);

        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, true);
        call_success_callback();
        const audio_link_regex =
            /\[translated: Join voice call\.]\(\/calls\/bigbluebutton\/join\?meeting_id=%22zulip-1%22&moderator=%22AAAAAAAAAA%22&lock_settings_disable_cam=true&checksum=%2232702220bff2a22a44aee72e96cfdb4c4091752e%22\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, audio_link_regex);
    })();

    (function test_bbb_meeting_name_empty_label() {
        const $textarea = $.create("bbb-empty-label-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override_rewire(compose_call_ui, "get_recipient_label_for_call", () => undefined);

        let checked = false;
        channel.get = (options) => {
            assert.equal(options.data.meeting_name, "meeting");
            checked = true;
            return {abort() {}};
        };

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        assert.ok(checked);
    })();

    (function test_constructor_groups_video_link_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("constructor-groups-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
            success_callback = undefined;
        });

        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.constructor_groups.id,
        );

        let success_callback;
        function call_success_callback() {
            success_callback({
                result: "success",
                msg: "",
                url: "https://example.constructor.app/groups/room/room-123",
            });
        }

        channel.post = (payload) => {
            assert.equal(payload.url, "/json/calls/constructorgroups/create");
            assert.deepEqual(payload.data, {}); // Empty data object
            success_callback = payload.success;
            return {abort() {}};
        };

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        call_success_callback();
        const video_link_regex =
            /\[translated: Join video call\.]\(https:\/\/example\.constructor\.app\/groups\/room\/room-123\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);
    })();

    (function test_nextcloud_talk_audio_and_video_links_compose_clicked() {
        let syntax_to_insert;
        let called = false;

        const $textarea = $.create("nextcloud-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
            called = true;
            success_callback = undefined;
        });

        $("textarea#compose-textarea").val("");

        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.nextcloud_talk.id,
        );

        override_rewire(compose_call_ui, "get_recipient_label_for_call", () => ({
            label_text: "general",
        }));
        let success_callback;
        function call_success_callback() {
            assert.ok(success_callback !== undefined);
            success_callback({
                result: "success",
                msg: "",
                url: "https://nextcloud.example.com/index.php/call/abc123token",
            });
        }

        const xhr_object = {abort() {}};
        channel.post = (options) => {
            assert.equal(options.url, "/json/calls/nextcloud_talk/create");
            assert.equal(options.data.room_name, "general conversation");
            success_callback = options.success;
            return xhr_object;
        };

        $("textarea#compose-textarea").val("");

        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        call_success_callback();
        const video_link_regex =
            /\[translated: Join video call\.]\(https:\/\/nextcloud\.example\.com\/index\.php\/call\/abc123token\)/;
        assert.ok(called);
        assert.match(syntax_to_insert, video_link_regex);
    })();

    (function test_nextcloud_talk_room_name_empty_label() {
        const $textarea = $.create("nextcloud-empty-label-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override_rewire(compose_call_ui, "get_recipient_label_for_call", () => undefined);

        let checked = false;
        channel.post = (options) => {
            assert.equal(options.data.room_name, "conversation");
            checked = true;
            return {abort() {}};
        };

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        assert.ok(checked);
    })();

    (function test_livekit_links_compose_clicked() {
        let syntax_to_insert;

        const $textarea = $.create("livekit-target-stub");
        $textarea.set_parents_result(".message_edit_form", []);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
        });
        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.livekit.id,
        );

        $("textarea#compose-textarea").val("");
        compose_call_ui.generate_and_insert_audio_or_video_call_link($textarea, false);
        assert.match(
            syntax_to_insert,
            /^\[translated: Join video call\.]\(\/calls\/livekit\/join\?call_id=\d{15}\)$/,
        );
    })();

    (function test_livekit_links_message_edit_clicked() {
        let syntax_to_insert;

        const $button = $.create("livekit-edit-button-stub");
        const $row = $.create("livekit-edit-row-stub");
        $row.set_closest_results(".overlay-message-row", []);
        $row.attr("data-message-id", "42");
        $button.set_parents_result(".message_edit_form", $.create("livekit-edit-form-stub"));
        $button.set_parents_result(".message_row", $row);

        override(compose_ui, "insert_syntax_and_focus", (syntax) => {
            syntax_to_insert = syntax;
        });
        override(
            realm,
            "realm_video_chat_provider",
            realm_available_video_chat_providers.livekit.id,
        );
        compose_call_ui.generate_and_insert_audio_or_video_call_link($button, false);
        assert.match(
            syntax_to_insert,
            /^\[translated: Join video call\.]\(\/calls\/livekit\/join\?call_id=\d{15}\)$/,
        );

        compose_call_ui.generate_and_insert_audio_or_video_call_link($button, true);
        assert.match(
            syntax_to_insert,
            /^\[translated: Join voice call\.]\(\/calls\/livekit\/join\?call_id=\d{15}&voice_only=true\)$/,
        );
    })();
});

run_test("get_recipient_label_for_call", ({override}) => {
    const stream = make_stream({
        subscribed: true,
        name: "design",
        stream_id: 200,
    });
    stream_data.add_sub_for_tests(stream);

    // --- Compose-box branch (edit_message_id === undefined) ---

    // Stream + non-empty topic.
    override(compose_state, "get_message_type", () => "stream");
    override(compose_state, "stream_id", () => stream.stream_id);
    override(compose_state, "topic", () => "typography");
    assert.equal(
        compose_call_ui.get_recipient_label_for_call(undefined).label_text,
        "#design > typography",
    );

    // Stream with no stream_id → undefined.
    override(compose_state, "stream_id", () => undefined);
    assert.equal(compose_call_ui.get_recipient_label_for_call(undefined), undefined);

    // DM with distinct recipients uses the recipient full names. User 2 is
    // "Bob", set up at the top of this file.
    override(compose_state, "get_message_type", () => "private");
    override(compose_state, "private_message_recipient_ids", () => [2]);
    override(message_store, "get_pm_full_names", () => "Bob");
    assert.equal(compose_call_ui.get_recipient_label_for_call(undefined).label_text, "Bob");

    // DM compose with no pills selected yet → undefined, so the meeting-name
    // fallback produces "meeting" instead of leaking the caller's own name via
    // sorted_other_user_ids's self-DM fallback.
    override(compose_state, "private_message_recipient_ids", () => []);
    assert.equal(compose_call_ui.get_recipient_label_for_call(undefined), undefined);

    // Unknown message type → undefined.
    override(compose_state, "get_message_type", () => undefined);
    assert.equal(compose_call_ui.get_recipient_label_for_call(undefined), undefined);

    // --- Edit-form branch (edit_message_id !== undefined) ---
    // The edit-form path reads from message_store, not compose_state, so we
    // deliberately don't override compose_state here.

    // Stream edit target uses the message's own stream/topic.
    override(message_store, "get", () => ({
        is_stream: true,
        is_private: false,
        stream_id: stream.stream_id,
        topic: "reviews",
    }));
    assert.equal(
        compose_call_ui.get_recipient_label_for_call("42").label_text,
        "#design > reviews",
    );

    // DM edit target uses the message's own recipients.
    override(message_store, "get", () => ({
        is_stream: false,
        is_private: true,
        to_user_ids: "2",
    }));
    override(message_store, "get_pm_full_names", () => "Bob");
    assert.equal(compose_call_ui.get_recipient_label_for_call("43").label_text, "Bob");

    // Unknown/evicted message id → undefined.
    override(message_store, "get", () => undefined);
    assert.equal(compose_call_ui.get_recipient_label_for_call("999"), undefined);
});

test("compute_show_video_chat_button disabled", ({override}) => {
    override(realm, "realm_video_chat_provider", realm_available_video_chat_providers.disabled.id);
    assert.equal(compose_call.compute_show_video_chat_button(), false);
    assert.equal(compose_call.compute_show_audio_chat_button(), false);
});

test("compute_show_video_chat_button no url", ({override}) => {
    override(
        realm,
        "realm_video_chat_provider",
        realm_available_video_chat_providers.jitsi_meet.id,
    );
    page_params.jitsi_server_url = null;
    assert.equal(compose_call.compute_show_video_chat_button(), false);
});

test("compute_show_video_chat_button enabled", ({override}) => {
    override(
        realm,
        "realm_video_chat_provider",
        realm_available_video_chat_providers.jitsi_meet.id,
    );
    override(realm, "realm_jitsi_server_url", "https://meet.jit.si");
    assert.equal(compose_call.compute_show_video_chat_button(), true);
});

test("compute_show_audio_chat_button livekit", ({override}) => {
    override(realm, "realm_video_chat_provider", realm_available_video_chat_providers.livekit.id);
    assert.equal(compose_call.compute_show_audio_chat_button(), true);
});

test("compute_show_video_chat_button constructor groups", ({override}) => {
    override(
        realm,
        "realm_video_chat_provider",
        realm_available_video_chat_providers.constructor_groups.id,
    );
    assert.equal(compose_call.compute_show_video_chat_button(), true);
});

test("is_livekit_call_provider", ({override}) => {
    override(realm, "realm_video_chat_provider", realm_available_video_chat_providers.livekit.id);
    assert.equal(compose_call.is_livekit_call_provider(), true);
    override(realm, "realm_video_chat_provider", realm_available_video_chat_providers.zoom.id);
    assert.equal(compose_call.is_livekit_call_provider(), false);
});
