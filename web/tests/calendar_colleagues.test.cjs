"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const channel = mock_esm("../src/channel");

const calendar_colleagues = zrequire("calendar_colleagues");
const {localstorage} = zrequire("localstorage");
const people = zrequire("people");

const cordelia = make_user({user_id: 11, full_name: "Cordelia, Lear's daughter"});
const othello = make_user({user_id: 12, full_name: "Othello, the Moor of Venice"});
const prospero = make_user({user_id: 13, full_name: "Prospero from The Tempest"});
people.add_active_user(cordelia, "server_events");
people.add_active_user(othello, "server_events");
people.add_active_user(prospero, "server_events");
people.deactivate(prospero);

let changes = 0;
calendar_colleagues.initialize({
    on_colleagues_change() {
        changes += 1;
    },
});

function test(label, f) {
    run_test(label, (helpers) => {
        window.localStorage.clear();
        changes = 0;
        f(helpers);
    });
}

function load(pinned_users, override) {
    override(channel, "get", (options) => {
        assert.equal(options.url, "/json/calendar/pinned_users");
        options.success({pinned_users});
    });
    calendar_colleagues.fetch(() => {});
}

test("colors", () => {
    assert.equal(
        calendar_colleagues.get_theme_color("#2f6fc4"),
        "light-dark(#2f6fc4, #4d94e8)",
    );
    // A color from elsewhere is used in both themes.
    assert.equal(calendar_colleagues.get_theme_color("#123456"), "#123456");

    assert.equal(calendar_colleagues.get_next_color([]), "#2f6fc4");
    assert.equal(calendar_colleagues.get_next_color(["#2f6fc4", "#c25e00"]), "#1e8a45");
    const all = ["#2f6fc4", "#1e8a45", "#c25e00", "#c4314b", "#b4009e", "#8f6b00"];
    assert.equal(calendar_colleagues.get_next_color(all), "#2f6fc4");
    assert.equal(calendar_colleagues.get_next_color([...all, "#2f6fc4"]), "#1e8a45");
});

test("colleagues", ({override}) => {
    load(
        [
            {user_id: othello.user_id, color: "#2f6fc4"},
            {user_id: prospero.user_id, color: "#1e8a45"},
            {user_id: cordelia.user_id, color: "#123456"},
        ],
        override,
    );
    assert.equal(changes, 1);
    // Deactivated colleagues are not listed.
    assert.deepEqual(calendar_colleagues.get_colleagues(), [
        {
            user_id: othello.user_id,
            full_name: othello.full_name,
            color: "light-dark(#2f6fc4, #4d94e8)",
            is_shown: false,
        },
        {
            user_id: cordelia.user_id,
            full_name: cordelia.full_name,
            color: "#123456",
            is_shown: false,
        },
    ]);
    assert.ok(calendar_colleagues.is_pinned(prospero.user_id));
    assert.ok(!calendar_colleagues.is_pinned(99));

    calendar_colleagues.set_shown(cordelia.user_id, true);
    calendar_colleagues.set_shown(othello.user_id, true);
    calendar_colleagues.set_shown(othello.user_id, false);
    assert.equal(changes, 4);
    assert.deepEqual(
        calendar_colleagues.get_shown_colleagues().map((colleague) => colleague.user_id),
        [cordelia.user_id],
    );

    // Other data in local storage is ignored.
    localstorage().set("calendar-shown-colleagues", {data: "x"});
    assert.deepEqual(calendar_colleagues.get_shown_colleagues(), []);
});

test("pin and unpin", ({override}) => {
    load([{user_id: othello.user_id, color: "#2f6fc4"}], override);

    override(channel, "post", (options) => {
        assert.equal(options.url, "/json/calendar/pinned_users");
        assert.deepEqual(options.data, {user_id: "11", color: "#1e8a45"});
        options.success();
    });
    calendar_colleagues.pin(cordelia.user_id, () => {});
    assert.deepEqual(
        calendar_colleagues.get_shown_colleagues().map((colleague) => colleague.user_id),
        [cordelia.user_id],
    );

    override(channel, "del", (options) => {
        assert.equal(options.url, "/json/calendar/pinned_users/11");
        options.success();
    });
    calendar_colleagues.unpin(cordelia.user_id, () => {});
    assert.ok(!calendar_colleagues.is_pinned(cordelia.user_id));
    assert.deepEqual(calendar_colleagues.get_shown_colleagues(), []);
    assert.equal(changes, 3);
});

test("side by side", ({override}) => {
    load([{user_id: othello.user_id, color: "#2f6fc4"}], override);
    calendar_colleagues.set_shown(othello.user_id, true);
    assert.ok(calendar_colleagues.is_side_by_side_enabled());
    assert.equal(calendar_colleagues.get_shown_colleagues().length, 1);

    // Turning side by side off hides the checked colleagues, who stay
    // checked.
    calendar_colleagues.set_side_by_side_enabled(false);
    assert.ok(!calendar_colleagues.is_side_by_side_enabled());
    assert.deepEqual(calendar_colleagues.get_shown_colleagues(), []);
    assert.ok(calendar_colleagues.get_colleagues()[0].is_shown);

    calendar_colleagues.set_side_by_side_enabled(true);
    assert.equal(calendar_colleagues.get_shown_colleagues().length, 1);
    assert.equal(changes, 4);
});
