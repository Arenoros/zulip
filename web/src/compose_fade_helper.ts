import {$} from "jquery";

import * as compose_state from "./compose_state.ts";
import type {Message} from "./message_store.ts";
import * as stream_data from "./stream_data.ts";
import * as sub_store from "./sub_store.ts";
import type {Recipient} from "./util.ts";
import * as util from "./util.ts";

let focused_recipient: Recipient | undefined;

export function should_fade_message(message: Message): boolean {
    return !util.same_recipient(focused_recipient, message);
}

export function clear_focused_recipient(): void {
    focused_recipient = undefined;
}

export function set_focused_recipient(recipient?: Recipient): void {
    focused_recipient = recipient;
}

export function want_normal_display(): boolean {
    // If we're not composing show a normal display.
    if (focused_recipient === undefined) {
        return true;
    }

    // The form for a new conversation writes to a topic that no card
    // in the conversations view shows yet.
    if (compose_state.is_new_conversation_form()) {
        return true;
    }

    // If the user really hasn't specified anything let, then we want a normal display
    if (focused_recipient.type === "stream") {
        // If a stream doesn't exist, there is no real chance of a mix, so fading
        // is just noise to the user.
        if (!sub_store.get(focused_recipient.stream_id)) {
            return true;
        }

        // If the topic is empty, we want a normal display in the following cases:
        // * realm requires topic
        // * realm allows empty topic but the focus is in topic input box,
        //   means user is still configuring topic.
        if (
            focused_recipient.topic === "" &&
            (!stream_data.can_use_empty_topic(focused_recipient.stream_id) ||
                $("input#stream_message_recipient_topic").is(":focus"))
        ) {
            return true;
        }
    }

    return focused_recipient.type === "private" && !focused_recipient.to_user_ids;
}
