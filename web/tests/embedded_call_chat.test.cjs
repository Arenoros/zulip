"use strict";

const assert = require("node:assert/strict");

const {JSDOM} = require("jsdom");

const {make_stream} = require("./lib/example_stream.cjs");
const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, set_global, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {$} = require("./lib/zjquery.cjs");

const {window: jsdom_window} = new JSDOM("", {url: "http://zulip.zulipdev.com/"});
set_global("Element", jsdom_window.Element);
set_global("HTMLAnchorElement", jsdom_window.HTMLAnchorElement);

const unread_counts = {dm: new Map(), topic: new Map()};
mock_esm("../src/unread", {
    num_unread_for_user_ids_string: (user_ids_string) => unread_counts.dm.get(user_ids_string) ?? 0,
    num_unread_for_topic: (stream_id, topic) =>
        unread_counts.topic.get(`${stream_id}:${topic}`) ?? 0,
});
let update_unread_counts_hook;
mock_esm("../src/unread_ui", {
    register_update_unread_counts_hook(hook) {
        update_unread_counts_hook = hook;
    },
});

const embedded_call_chat = zrequire("embedded_call_chat");
const {Filter} = zrequire("filter");
const people = zrequire("people");
const {set_current_user} = zrequire("state_data");
const stream_data = zrequire("stream_data");

const me = make_user({user_id: 1, full_name: "Me Myself"});
const alice = make_user({user_id: 2, full_name: "Alice"});
const bob = make_user({user_id: 3, full_name: "Bob"});
for (const user of [me, alice, bob]) {
    people.add_active_user(user);
    people.add_valid_user_id(user.user_id);
}
people.initialize_current_user(me.user_id);
set_current_user({user_id: me.user_id});
const verona = make_stream({stream_id: 5, name: "Verona"});
stream_data.add_sub_for_tests(verona);

function filter(raw_terms) {
    return new Filter(raw_terms.map(([operator, operand]) => ({operator, operand})));
}

// The call window that frames the web app, and what it was sent.
const call_window = {
    location: {origin: window.location.origin},
    posted: [],
    postMessage(message, target_origin) {
        assert.equal(target_origin, window.location.origin);
        this.posted.push(message);
    },
};
const window_listeners = new Map();
const document_listeners = new Map();
const opened_urls = [];
const replaced_urls = [];

function set_up_frame({name = "zulip-call-chat", parent = call_window, hash}) {
    set_global("name", name);
    set_global("parent", parent);
    set_global("addEventListener", (type, listener) => {
        window_listeners.set(type, listener);
    });
    set_global("document", {
        addEventListener(type, listener, use_capture) {
            assert.ok(use_capture);
            document_listeners.set(type, listener);
        },
    });
    set_global("history", {
        state: null,
        replaceState(state, _unused, url) {
            assert.equal(state, null);
            replaced_urls.push(url);
        },
    });
    set_global("open", (url, target, features) => {
        assert.equal(target, "_blank");
        assert.equal(features, "noopener,noreferrer");
        opened_urls.push(url);
    });
    window.location.hash = hash;
    call_window.posted = [];
    opened_urls.length = 0;
    replaced_urls.length = 0;
}

run_test("not a call chat", () => {
    set_up_frame({name: "", hash: "#narrow/dm/2"});
    embedded_call_chat.initialize();
    assert.ok(!embedded_call_chat.is_active());

    set_up_frame({parent: window, hash: "#narrow/dm/2"});
    embedded_call_chat.initialize();
    assert.ok(!embedded_call_chat.is_active());

    // A page from another origin cannot frame the web app this way.
    set_up_frame({
        parent: {
            get location() {
                throw new Error("Blocked a frame from accessing a cross-origin frame.");
            },
        },
        hash: "#narrow/dm/2",
    });
    embedded_call_chat.initialize();
    assert.ok(!embedded_call_chat.is_active());

    set_up_frame({hash: "#recent"});
    embedded_call_chat.initialize();
    assert.ok(!embedded_call_chat.is_active());
    assert.ok(!$("body").hasClass("embedded-call-chat"));
    assert.equal(call_window.posted.length, 0);
});

run_test("direct message call chat", () => {
    unread_counts.dm.set("2", 3);
    set_up_frame({hash: "#narrow/dm/1,2"});
    embedded_call_chat.initialize();
    assert.ok(embedded_call_chat.is_active());
    assert.ok($("body").hasClass("embedded-call-chat"));
    assert.deepEqual(call_window.posted, [{type: "call_chat_unread_count", count: 3}]);

    // The call window only hears about changes.
    update_unread_counts_hook();
    unread_counts.dm.set("2", 0);
    update_unread_counts_hook();
    assert.deepEqual(call_window.posted.at(-1), {type: "call_chat_unread_count", count: 0});
    assert.equal(call_window.posted.length, 2);

    assert.ok(embedded_call_chat.is_call_chat(filter([["dm", [2]]])));
    assert.ok(embedded_call_chat.is_call_chat(filter([["dm", [1, 2]]])));
    assert.ok(!embedded_call_chat.is_call_chat(filter([["dm", [3]]])));
    assert.ok(!embedded_call_chat.is_call_chat(filter([["dm", [2, 3]]])));
    assert.ok(!embedded_call_chat.is_call_chat(filter([["in", "home"]])));
    assert.ok(
        !embedded_call_chat.is_call_chat(
            filter([
                ["channel", "5"],
                ["topic", "standup"],
            ]),
        ),
    );

    assert.ok(embedded_call_chat.is_call_chat_hash("#narrow/dm/2-Alice"));
    assert.ok(embedded_call_chat.is_call_chat_hash("#narrow/dm/1,2/near/10"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/dm/3"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#recent"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/dm"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/%E0%A4%A/2"));

    const dm_to = (user_ids) => ({
        message_type: "private",
        topic: "",
        private_message_recipient_ids: user_ids,
    });
    const topic_in = (stream_id, topic) => ({
        message_type: "stream",
        stream_id,
        topic,
        private_message_recipient_ids: [],
    });
    assert.ok(embedded_call_chat.is_call_chat_recipient(dm_to([2])));
    assert.ok(!embedded_call_chat.is_call_chat_recipient(dm_to([3])));
    assert.ok(!embedded_call_chat.is_call_chat_recipient(topic_in(5, "standup")));
    assert.ok(!embedded_call_chat.is_call_chat_recipient(topic_in(undefined, "")));

    // Other conversations open in a new tab.
    embedded_call_chat.open_recipient_in_new_tab(dm_to([3]));
    embedded_call_chat.open_recipient_in_new_tab(topic_in(5, "standup"));
    embedded_call_chat.open_recipient_in_new_tab(dm_to([]));
    embedded_call_chat.open_recipient_in_new_tab(topic_in(undefined, ""));
    assert.deepEqual(opened_urls, [
        "http://zulip.zulipdev.com/#narrow/dm/3-Bob",
        "http://zulip.zulipdev.com/#narrow/channel/5-Verona/topic/standup",
    ]);

    // Leaving the call chat returns to it.
    embedded_call_chat.restore_call_chat_hash("#narrow/dm/2/near/10");
    embedded_call_chat.restore_call_chat_hash("#recent");
    embedded_call_chat.restore_call_chat_hash(undefined);
    assert.deepEqual(replaced_urls, ["#narrow/dm/2/near/10", "#narrow/dm/1,2", "#narrow/dm/1,2"]);
});

run_test("links in the call chat", () => {
    opened_urls.length = 0;
    const on_click = document_listeners.get("click");
    const document = jsdom_window.document;
    document.body.innerHTML = `
        <a class="other" href="#narrow/dm/3"><span class="icon"></span></a>
        <a class="same" href="#narrow/dm/2/near/10"></a>
        <a class="external" href="https://example.com/#narrow/dm/3"></a>
        <a class="upload" href="/user_uploads/1/ab/file.pdf"></a>
        <span class="text"></span>`;
    function click(target, opts = {}) {
        const event = {
            button: 0,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            target,
            ...opts,
            default_prevented: false,
            propagation_stopped: false,
            preventDefault() {
                this.default_prevented = true;
            },
            stopPropagation() {
                this.propagation_stopped = true;
            },
        };
        on_click(event);
        return event.default_prevented && event.propagation_stopped;
    }
    const icon = document.querySelector(".icon");
    assert.ok(click(icon));
    assert.deepEqual(opened_urls, ["http://zulip.zulipdev.com/#narrow/dm/3"]);

    assert.ok(!click(icon, {button: 1}));
    assert.ok(!click(icon, {ctrlKey: true}));
    assert.ok(!click(icon, {metaKey: true}));
    assert.ok(!click(icon, {shiftKey: true}));
    assert.ok(!click(document));
    assert.ok(!click(document.querySelector(".text")));
    assert.ok(!click(document.querySelector(".same")));
    assert.ok(!click(document.querySelector(".external")));
    assert.ok(!click(document.querySelector(".upload")));
    assert.equal(opened_urls.length, 1);
});

run_test("messages from the call window", () => {
    const on_message = window_listeners.get("message");
    let focused = false;
    $("textarea#compose-textarea").on("focus", () => {
        focused = true;
    });
    const send = (data, opts = {}) => {
        on_message({origin: window.location.origin, source: call_window, data, ...opts});
    };

    send({type: "focus_compose"}, {origin: "https://example.com"});
    send({type: "focus_compose"}, {source: window});
    assert.ok(!focused);
    send({type: "focus_compose"});
    assert.ok(focused);

    // The call chat moves to the group direct message of everyone
    // called to the call.
    send({type: "show_call_chat", hash: "#recent"});
    assert.ok(embedded_call_chat.is_call_chat_hash("#narrow/dm/2"));
    unread_counts.dm.set("2,3", 1);
    send({type: "show_call_chat", hash: "#narrow/dm/1,2,3"});
    assert.equal(window.location.hash, "#narrow/dm/1,2,3");
    assert.ok(embedded_call_chat.is_call_chat_hash("#narrow/dm/2,3"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/dm/2"));
    assert.deepEqual(call_window.posted.at(-1), {type: "call_chat_unread_count", count: 1});
    embedded_call_chat.restore_call_chat_hash(undefined);
    assert.equal(replaced_urls.at(-1), "#narrow/dm/1,2,3");
});

run_test("channel call chat", () => {
    unread_counts.topic.set("5:Standup", 2);
    set_up_frame({hash: "#narrow/channel/5-Verona/topic/Standup"});
    embedded_call_chat.initialize();
    assert.deepEqual(call_window.posted, [{type: "call_chat_unread_count", count: 2}]);

    assert.ok(
        embedded_call_chat.is_call_chat(
            filter([
                ["channel", "5"],
                ["topic", "standup"],
            ]),
        ),
    );
    assert.ok(embedded_call_chat.is_call_chat_hash("#narrow/channel/5/topic/standup/with/7"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/channel/5/topic/lunch"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/channel/99/topic/standup"));
    assert.ok(!embedded_call_chat.is_call_chat_hash("#narrow/dm/2"));
    assert.ok(
        embedded_call_chat.is_call_chat_recipient({
            message_type: "stream",
            stream_id: 5,
            topic: "Standup",
            private_message_recipient_ids: [],
        }),
    );
    assert.ok(
        !embedded_call_chat.is_call_chat_recipient({
            message_type: "private",
            topic: "",
            private_message_recipient_ids: [2],
        }),
    );
});
