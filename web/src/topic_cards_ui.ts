import {$} from "jquery";

import * as compose_actions from "./compose_actions.ts";
import * as message_fetch from "./message_fetch.ts";
import type {MessageList} from "./message_list.ts";
import * as message_lists from "./message_lists.ts";
import type {Message} from "./message_store.ts";
import * as message_viewport from "./message_viewport.ts";
import * as rows from "./rows.ts";
import * as topic_cards from "./topic_cards.ts";

// Actions on the topic cards of a channel's conversations view.

function get_card(elem: HTMLElement):
    | {
          msg_list: MessageList;
          $card: JQuery;
          first_message: Message & {type: "stream"};
      }
    | undefined {
    const msg_list = message_lists.current;
    if (!msg_list?.is_conversations_view) {
        return undefined;
    }
    const $card = $(elem).closest(".recipient_row");
    const first_message = msg_list.get(rows.id($card.find(".message_row").first()));
    if (first_message?.type !== "stream") {
        return undefined;
    }
    return {msg_list, $card, first_message};
}

function open_hidden_replies(elem: HTMLElement): void {
    const card = get_card(elem);
    if (card === undefined) {
        return;
    }
    const {msg_list, $card, first_message} = card;
    const oldest_shown_reply = $card.find(".message_row").eq(1);
    // Keep the card's first message where it is while the replies
    // appear below it.
    msg_list.select_id(first_message.id, {then_scroll: false});
    message_fetch.load_topic_card_replies({
        msg_list,
        stream_id: first_message.stream_id,
        topic: first_message.topic,
        anchor: rows.id(oldest_shown_reply),
    });
}

function collapse_replies(elem: HTMLElement): void {
    const card = get_card(elem);
    if (card === undefined) {
        return;
    }
    const {msg_list, first_message} = card;
    msg_list.select_id(first_message.id, {then_scroll: false});
    topic_cards.set_expanded(msg_list, first_message.topic, false);
    msg_list.view.rerender_preserving_scrolltop(true);
}

function reply_in_topic(elem: HTMLElement): void {
    const card = get_card(elem);
    if (card === undefined) {
        return;
    }
    compose_actions.start({
        message_type: "stream",
        stream_id: card.first_message.stream_id,
        topic: card.first_message.topic,
        trigger: "topic card reply",
    });
}

function on_click_or_enter(
    selector: string,
    handler: (elem: HTMLElement) => void,
): void {
    $("#message_feed_container").on("click", selector, function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        handler(this);
    });
    $("#message_feed_container").on("keydown", selector, function (this: HTMLElement, e) {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            handler(this);
        }
    });
}

export function initialize(): void {
    on_click_or_enter(".topic-card-hidden-replies-label", open_hidden_replies);
    on_click_or_enter(".topic-card-collapse", collapse_replies);
    on_click_or_enter(".topic-card-reply-button", reply_in_topic);

    $("#message_feed_container").on("click", ".topic-cards-unread-above-button", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Go to the nearest card with unread messages above the
        // visible part of the feed.
        const visible_top = message_viewport.message_viewport_info().visible_top;
        const card = $(".focused-message-list .recipient_row.topic-card-unread")
            .toArray()
            .findLast((card) => card.getBoundingClientRect().bottom < visible_top);
        if (card !== undefined && message_lists.current !== undefined) {
            message_lists.current.select_id(rows.id($(card).find(".message_row").first()), {
                then_scroll: true,
            });
        }
    });

    $("#topic-cards-new-replies").on("click", ".topic-cards-new-replies-button", (e) => {
        e.preventDefault();
        $("#topic-cards-new-replies").removeClass("show");
        const $last_row = rows.last_visible();
        if ($last_row.length > 0 && message_lists.current !== undefined) {
            message_lists.current.select_id(rows.id($last_row), {then_scroll: true});
        }
    });
}
