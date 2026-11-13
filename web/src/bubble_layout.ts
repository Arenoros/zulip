import type {Filter} from "./filter.ts";
import * as settings_config from "./settings_config.ts";
import * as stream_data from "./stream_data.ts";
import {user_settings} from "./user_settings.ts";

// A single direct message conversation is shown as chat bubbles if the
// user has the setting on; views that mix conversations keep the
// classic layout.
export function is_bubble_layout(filter: Filter): boolean {
    return (
        filter.is_conversation_view() &&
        filter.has_operator("dm") &&
        user_settings.web_direct_message_bubbles
    );
}

// A topic opens as an open conversation where channels open as their
// conversations view, which the open conversation leads back to.
export function is_open_conversation(filter: Filter): boolean {
    if (
        !filter.is_conversation_view() ||
        !filter.has_operator("channel") ||
        user_settings.web_channel_default_view !==
            settings_config.web_channel_default_view_values.conversations.code
    ) {
        return false;
    }
    const channel_id = Number.parseInt(filter.terms_with_operator("channel")[0]!.operand, 10);
    return (
        stream_data.get_sub_by_id(channel_id) !== undefined &&
        !stream_data.is_empty_topic_only_channel(channel_id)
    );
}

// The chat layout shows a single conversation as a chat: messages in
// series broken by pauses, a date divider at the start of each day,
// and a divider where unread messages start, without recipient bars.
export function is_chat_layout(filter: Filter): boolean {
    return is_bubble_layout(filter) || is_open_conversation(filter);
}
