"use strict";

const assert = require("node:assert/strict");

const {make_realm} = require("./lib/example_realm.cjs");
const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const people = zrequire("people");
const {set_current_user, set_realm} = zrequire("state_data");
const topic_cards = zrequire("topic_cards");

set_realm(make_realm());
set_current_user({is_guest: false});

const alice = {user_id: 1, email: "alice@example.com", full_name: "Alice"};
const bob = {user_id: 2, email: "bob@example.com", full_name: "Bob"};
const carol = {user_id: 3, email: "carol@example.com", full_name: "Carol"};
const dave = {user_id: 4, email: "dave@example.com", full_name: "Dave"};
for (const user of [alice, bob, carol, dave]) {
    people.add_active_user(user);
}

let next_list_id = 0;
function make_list() {
    next_list_id += 1;
    return {id: next_list_id};
}

function message(id, topic, sender) {
    return {id, type: "stream", stream_id: 5, topic, sender_id: sender.user_id};
}

function card_ids(card) {
    return [card.first_message.id, ...card.replies.map((reply) => reply.id)];
}

run_test("cards from the messages of the list", () => {
    const msg_list = make_list();
    const messages = [
        message(1, "lunch", alice),
        message(2, "Plans", bob),
        message(3, "lunch", bob),
        {id: 4, type: "private", sender_id: alice.user_id},
        message(5, "plans", carol),
        message(6, "lunch", carol),
        message(7, "lunch", dave),
        message(8, "lunch", alice),
        message(9, "lunch", bob),
    ];
    const cards = topic_cards.get_topic_cards(msg_list, messages);
    // Topics are compared case-insensitively, the least recently
    // active first, and each card shows the three latest replies.
    assert.deepEqual(cards.map(card_ids), [
        [2, 5],
        [1, 7, 8, 9],
    ]);
    assert.equal(cards[0].hidden_replies, undefined);
    // Without what the server told us, the hidden replies are the
    // loaded ones, their authors most recent first.
    assert.deepEqual(cards[1].hidden_replies, {
        count: 2,
        sender_names: ["Carol", "Bob"],
        other_sender_count: 0,
    });
});

run_test("cards with what the server told us", () => {
    const msg_list = make_list();
    assert.equal(topic_cards.get_anchor(msg_list), undefined);
    topic_cards.add_topic_card_info(msg_list, [
        {
            topic_name: "Lunch",
            max_id: 20,
            first_message_id: 10,
            reply_count: 8,
            hidden_reply_sender_ids: [carol.user_id, dave.user_id, bob.user_id],
            hidden_reply_sender_count: 4,
        },
        {
            topic_name: "plans",
            max_id: 15,
            first_message_id: 15,
            reply_count: 0,
            hidden_reply_sender_ids: [],
            hidden_reply_sender_count: 0,
        },
    ]);
    // The next page holds the topics last active before these.
    assert.equal(topic_cards.get_anchor(msg_list), 15);

    const messages = [
        message(10, "lunch", alice),
        message(15, "plans", bob),
        message(18, "lunch", bob),
        message(19, "lunch", carol),
        message(20, "lunch", alice),
        // A reply that arrived after the server counted the replies.
        message(21, "lunch", dave),
    ];
    let cards = topic_cards.get_topic_cards(msg_list, messages);
    assert.deepEqual(cards.map(card_ids), [
        [15],
        [10, 19, 20, 21],
    ]);
    assert.deepEqual(cards[1].hidden_replies, {
        count: 6,
        sender_names: ["Bob", "Carol"],
        other_sender_count: 2,
    });

    // A topic whose first message was moved away starts with its
    // first loaded message.
    cards = topic_cards.get_topic_cards(msg_list, messages.slice(2));
    assert.deepEqual(cards.map(card_ids), [[18, 19, 20, 21]]);

    topic_cards.forget_message_list(msg_list.id);
    assert.equal(topic_cards.get_anchor(msg_list), undefined);
});

run_test("expanded cards", () => {
    const msg_list = make_list();
    const messages = [
        message(1, "lunch", alice),
        message(2, "lunch", bob),
        message(3, "lunch", carol),
        message(4, "lunch", dave),
        message(5, "lunch", alice),
    ];
    // An expanded card shows every loaded reply.
    topic_cards.set_expanded(msg_list, "Lunch", true);
    let [card] = topic_cards.get_topic_cards(msg_list, messages);
    assert.deepEqual(card_ids(card), [1, 2, 3, 4, 5]);
    assert.ok(card.expanded);
    assert.equal(card.hidden_replies, undefined);

    topic_cards.set_expanded(msg_list, "lunch", false);
    [card] = topic_cards.get_topic_cards(msg_list, messages);
    assert.deepEqual(card_ids(card), [1, 3, 4, 5]);
    assert.ok(!card.expanded);

    topic_cards.set_expanded(msg_list, "lunch", true);
    topic_cards.forget_message_list(msg_list.id);
    [card] = topic_cards.get_topic_cards(msg_list, messages);
    assert.ok(!card.expanded);
});
