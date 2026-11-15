"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const calendar_filter = zrequire("calendar_filter");
const {localstorage} = zrequire("localstorage");

const ME = 1;

function event(title, fields = {}) {
    return {
        title,
        original_start: null,
        show_as: 3,
        organizer_id: 2,
        response: 2,
        category: "",
        attendees: [{user_id: 1}, {user_id: 2}],
        ...fields,
    };
}

const events = [
    event("personal", {organizer_id: ME, attendees: [{user_id: ME}]}),
    event("organized", {organizer_id: ME}),
    event("accepted"),
    event("tentative", {response: 3, show_as: 2}),
    event("unanswered", {response: 1}),
    event("followed", {response: 5, show_as: 1}),
    event("red", {category: "Red category"}),
    event("series", {original_start: 1_800_000_000}),
];

function shown() {
    return calendar_filter.filter_events(events, ME).map((event) => event.title);
}

function test(label, f) {
    run_test(label, () => {
        window.localStorage.clear();
        f();
    });
}

test("event keys", () => {
    assert.deepEqual(calendar_filter.get_event_keys(events[0], ME), [
        "personal",
        "category:",
        "show_as:3",
    ]);
    assert.deepEqual(calendar_filter.get_event_keys(events[3], ME), [
        "meetings:tentative",
        "category:",
        "show_as:2",
    ]);
    assert.deepEqual(calendar_filter.get_event_keys(events[7], ME), [
        "meetings:accepted",
        "category:",
        "show_as:3",
        "recurring",
    ]);
    assert.equal(calendar_filter.get_category_key("Red category"), "category:Red category");
    assert.equal(calendar_filter.MEETING_KEYS.length, 5);
    assert.deepEqual(calendar_filter.SHOW_AS_KEYS, [
        "show_as:1",
        "show_as:2",
        "show_as:3",
        "show_as:4",
        "show_as:5",
    ]);
});

test("filtering", () => {
    assert.ok(!calendar_filter.is_filtering());
    assert.equal(shown().length, events.length);

    calendar_filter.set_hidden(["personal", "meetings:organizer"], true);
    assert.ok(calendar_filter.is_filtering());
    assert.deepEqual(shown(), [
        "accepted",
        "tentative",
        "unanswered",
        "followed",
        "red",
        "series",
    ]);

    calendar_filter.set_hidden(["meetings:organizer"], false);
    calendar_filter.set_hidden(
        ["meetings:none", "meetings:following", "category:Red category", "recurring"],
        true,
    );
    assert.deepEqual(shown(), ["organized", "accepted", "tentative"]);

    calendar_filter.set_hidden(["show_as:2"], true);
    assert.deepEqual(shown(), ["organized", "accepted"]);
    assert.deepEqual(
        [...calendar_filter.get_hidden_keys()],
        [
            "category:Red category",
            "meetings:following",
            "meetings:none",
            "personal",
            "recurring",
            "show_as:2",
        ],
    );

    calendar_filter.reset();
    assert.ok(!calendar_filter.is_filtering());
    assert.equal(shown().length, events.length);

    // Other data in local storage is ignored.
    localstorage().set("calendar-filter-hidden", {data: "x"});
    assert.ok(!calendar_filter.is_filtering());
});
