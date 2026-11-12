"use strict";

const assert = require("node:assert/strict");

const {make_user} = require("./lib/example_user.cjs");
const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const people = zrequire("people");
const personal_sections = zrequire("personal_sections");

const me = make_user({email: "me@zulip.com", user_id: 30, full_name: "Me Myself"});
const alice = make_user({email: "alice@zulip.com", user_id: 31, full_name: "Alice"});
const bob = make_user({email: "bob@zulip.com", user_id: 32, full_name: "Bob"});

people.add_active_user(me);
people.add_active_user(alice);
people.add_active_user(bob);
people.initialize_current_user(me.user_id);

function test(label, f) {
    run_test(label, (helpers) => {
        personal_sections.initialize({
            personal_sections: {
                conversation_sections: [
                    {name: "Project", conversations: [[31], [31, 32]]},
                    {name: "Notes", conversations: [[]]},
                ],
            },
        });
        f(helpers);
    });
}

test("get_conversation_sections", () => {
    // The conversation with oneself has the current user's ID in its
    // user_ids_string, but not on the server.
    assert.deepEqual(personal_sections.get_conversation_sections(), [
        {name: "Project", user_ids_strings: ["31", "31,32"]},
        {name: "Notes", user_ids_strings: ["30"]},
    ]);
    assert.equal(personal_sections.get_conversation_section_name("31,32"), "Project");
    assert.equal(personal_sections.get_conversation_section_name("30"), "Notes");
    assert.equal(personal_sections.get_conversation_section_name("32"), undefined);

    personal_sections.set_personal_sections({conversation_sections: []});
    assert.deepEqual(personal_sections.get_conversation_sections(), []);
});

test("with_conversation_moved", () => {
    // Moving a conversation takes it out of the section it was in.
    assert.deepEqual(personal_sections.with_conversation_moved("31", "Notes"), [
        {name: "Project", conversations: [[31, 32]]},
        {name: "Notes", conversations: [[], [31]]},
    ]);
    assert.deepEqual(personal_sections.with_conversation_moved("30", "Project"), [
        {name: "Project", conversations: [[31], [31, 32], []]},
        {name: "Notes", conversations: []},
    ]);
    assert.deepEqual(personal_sections.with_conversation_moved("32", "Project"), [
        {name: "Project", conversations: [[31], [31, 32], [32]]},
        {name: "Notes", conversations: [[]]},
    ]);
    // Moving a conversation to no section takes it out of its section.
    assert.deepEqual(personal_sections.with_conversation_moved("31,32", undefined), [
        {name: "Project", conversations: [[31]]},
        {name: "Notes", conversations: [[]]},
    ]);

    // The sections only change when the server reports a change.
    assert.equal(personal_sections.get_conversation_section_name("31"), "Project");
});

test("with_conversation_section_added", () => {
    assert.deepEqual(personal_sections.with_conversation_section_added("Friends", "31,32"), [
        {name: "Project", conversations: [[31]]},
        {name: "Notes", conversations: [[]]},
        {name: "Friends", conversations: [[31, 32]]},
    ]);
});

test("with_conversation_section_renamed", () => {
    assert.deepEqual(personal_sections.with_conversation_section_renamed("Notes", "Me"), [
        {name: "Project", conversations: [[31], [31, 32]]},
        {name: "Me", conversations: [[]]},
    ]);
});

test("with_conversation_section_removed", () => {
    assert.deepEqual(personal_sections.with_conversation_section_removed("Project"), [
        {name: "Notes", conversations: [[]]},
    ]);
});
