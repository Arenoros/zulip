import type {Filter} from "./filter.ts";
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
