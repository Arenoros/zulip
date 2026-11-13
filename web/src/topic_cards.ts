import * as z from "zod/mini";

import type {MessageList} from "./message_list.ts";
import type {Message} from "./message_store.ts";
import {raw_message_schema} from "./message_store.ts";
import * as people from "./people.ts";

// The conversations view shows a channel as topic cards: each topic's
// first message, followed by its latest replies. This module keeps what
// the server told us about each card and decides which messages each
// card shows.

export const NUM_TOPIC_CARD_REPLIES = 3;
export const NUM_TOPIC_CARDS_PER_FETCH = 20;

const topic_card_schema = z.object({
    topic_name: z.string(),
    max_id: z.number(),
    first_message_id: z.number(),
    reply_count: z.number(),
    hidden_reply_sender_ids: z.array(z.number()),
    hidden_reply_sender_count: z.number(),
});
export type TopicCardInfo = z.infer<typeof topic_card_schema>;

export const topic_cards_response_schema = z.object({
    topic_cards: z.array(topic_card_schema),
    messages: z.array(raw_message_schema),
    found_oldest: z.boolean(),
});

// What the server told us about each topic, by message list ID and
// then by topic key.
const topic_card_info = new Map<number, Map<string, TopicCardInfo>>();

function topic_key(topic: string): string {
    return topic.toLowerCase();
}

function get_topic_card_info(msg_list: MessageList): Map<string, TopicCardInfo> {
    let info = topic_card_info.get(msg_list.id);
    if (info === undefined) {
        info = new Map();
        topic_card_info.set(msg_list.id, info);
    }
    return info;
}

export function get_anchor(msg_list: MessageList): number | undefined {
    // Each page holds the topics last active before the oldest
    // topic we already have.
    const max_ids = [...get_topic_card_info(msg_list).values()].map((card) => card.max_id);
    return max_ids.length > 0 ? Math.min(...max_ids) : undefined;
}

export function add_topic_card_info(msg_list: MessageList, cards: TopicCardInfo[]): void {
    const info = get_topic_card_info(msg_list);
    for (const card of cards) {
        info.set(topic_key(card.topic_name), card);
    }
}

export function forget_message_list(msg_list_id: number): void {
    topic_card_info.delete(msg_list_id);
}

export type HiddenReplies = {
    count: number;
    sender_names: string[];
    other_sender_count: number;
};

export type TopicCard = {
    first_message: Message;
    replies: Message[];
    hidden_replies: HiddenReplies | undefined;
};

// Names of the authors of hidden replies, as in "From Alice, Bob, and
// 2 others": at most this many names.
const MAX_HIDDEN_REPLY_SENDER_NAMES = 2;

function get_hidden_replies(
    info: TopicCardInfo | undefined,
    loaded_replies: Message[],
    shown_replies: Message[],
): HiddenReplies | undefined {
    const loaded_hidden_replies = loaded_replies.slice(
        0,
        loaded_replies.length - shown_replies.length,
    );
    // Replies that arrived after the server counted them.
    const new_reply_count =
        info === undefined
            ? loaded_replies.length
            : info.reply_count + loaded_replies.filter((message) => message.id > info.max_id).length;
    const count = Math.max(new_reply_count, loaded_replies.length) - shown_replies.length;
    if (count <= 0) {
        return undefined;
    }

    // The most recent authors first.
    const sender_ids = [
        ...loaded_hidden_replies.toReversed().map((message) => message.sender_id),
        ...(info?.hidden_reply_sender_ids ?? []),
    ];
    const distinct_sender_ids = [...new Set(sender_ids)];
    const sender_count = Math.max(
        distinct_sender_ids.length,
        info?.hidden_reply_sender_count ?? 0,
    );
    const sender_names = distinct_sender_ids
        .slice(0, MAX_HIDDEN_REPLY_SENDER_NAMES)
        .map((user_id) => people.get_display_full_name(user_id));
    return {
        count,
        sender_names,
        other_sender_count: sender_count - sender_names.length,
    };
}

// The cards of a conversations view, the least recently active topic
// first, built from the messages the list holds.
export function get_topic_cards(msg_list: MessageList, messages: Message[]): TopicCard[] {
    const info = get_topic_card_info(msg_list);
    const messages_by_topic = new Map<string, Message[]>();
    for (const message of messages) {
        if (message.type !== "stream") {
            continue;
        }
        const key = topic_key(message.topic);
        const topic_messages = messages_by_topic.get(key) ?? [];
        topic_messages.push(message);
        messages_by_topic.set(key, topic_messages);
    }

    const cards: TopicCard[] = [];
    for (const [key, topic_messages] of messages_by_topic) {
        const card_info = info.get(key);
        // Messages in the list are sorted by ID. A topic's first
        // message may be missing if it was deleted or moved away.
        const first_message =
            topic_messages.find((message) => message.id === card_info?.first_message_id) ??
            topic_messages[0]!;
        const loaded_replies = topic_messages.filter((message) => message.id > first_message.id);
        const replies = loaded_replies.slice(-NUM_TOPIC_CARD_REPLIES);
        cards.push({
            first_message,
            replies,
            hidden_replies: get_hidden_replies(card_info, loaded_replies, replies),
        });
    }
    const last_id = (card: TopicCard): number => (card.replies.at(-1) ?? card.first_message).id;
    return cards.toSorted((a, b) => last_id(a) - last_id(b));
}
