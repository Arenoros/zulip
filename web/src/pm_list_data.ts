import * as blueslip from "./blueslip.ts";
import * as buddy_data from "./buddy_data.ts";
import * as hash_util from "./hash_util.ts";
import * as muted_users from "./muted_users.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import type {User} from "./people.ts";
import * as personal_sections from "./personal_sections.ts";
import * as pm_conversations from "./pm_conversations.ts";
import * as unread from "./unread.ts";
import * as user_status from "./user_status.ts";
import type {UserStatusEmojiInfo} from "./user_status.ts";
import * as util from "./util.ts";

// Maximum number of conversation threads to show in default view.
const max_conversations_to_show = 8;

// Maximum number of conversation threads to show in default view with unreads.
const max_conversations_to_show_with_unreads = 15;

export function get_active_user_ids_string(): string | undefined {
    const filter = narrow_state.filter();

    if (!filter) {
        return undefined;
    }

    const user_ids = filter.terms_with_operator("dm")[0]?.operand;

    if (!user_ids || user_ids.length === 0) {
        return undefined;
    }

    if (!people.is_valid_user_ids(user_ids)) {
        blueslip.warn("Invalid user_ids", {user_ids});
        return undefined;
    }

    return people.sorted_other_user_ids(user_ids).join(",");
}

export type PMListConversation = {
    user_ids_string: string;
};

export type DisplayObject = {
    recipients: string;
    user_ids_string: string;
    is_current_user: boolean;
    unread: number;
    is_zero: boolean;
    is_active: boolean;
    url: string;
    status_emoji_info: UserStatusEmojiInfo | undefined;
    user_circle_class: string | undefined;
    is_group: boolean;
    is_bot: boolean;
    has_unread_mention: boolean;
    includes_deactivated_user: boolean;
};

function get_display_object(
    user_ids_string: string,
    active_user_ids_string: string | undefined,
): DisplayObject {
    const user_ids = people.user_ids_string_to_ids_array(user_ids_string);
    const recipients_string = people.format_recipients(user_ids_string, "narrow");

    const num_unread = unread.num_unread_for_user_ids_string(user_ids_string);
    const has_unread_mention = unread.num_unread_mentions_for_user_ids_strings(user_ids_string) > 0;
    const is_group = user_ids_string.includes(",");
    const is_active = user_ids_string === active_user_ids_string;
    const includes_deactivated_user = user_ids.some(
        (id) => !people.is_active_user_or_system_bot(id),
    );

    let user_circle_class: string | undefined;
    let status_emoji_info: UserStatusEmojiInfo | undefined;
    let is_bot = false;
    let is_current_user = false;

    if (!is_group) {
        const user_id = Number.parseInt(user_ids_string, 10);
        user_circle_class = buddy_data.get_user_circle_class(user_id, includes_deactivated_user);
        const recipient_user_obj = people.get_by_user_id(user_id);

        if (recipient_user_obj.is_bot) {
            is_bot = true;
        } else {
            is_current_user = people.is_my_user_id(user_id);
            status_emoji_info = user_status.get_status_emoji(user_id);
        }
    }

    const display_object: DisplayObject = {
        recipients: recipients_string,
        user_ids_string,
        unread: num_unread,
        is_zero: num_unread === 0,
        is_active,
        url: hash_util.pm_with_url(user_ids_string),
        status_emoji_info,
        user_circle_class,
        is_group,
        is_bot,
        has_unread_mention,
        includes_deactivated_user,
        is_current_user,
    };
    return display_object;
}

export function get_conversations(search_string = ""): DisplayObject[] {
    const conversations = pm_conversations.recent.get();
    const display_objects: DisplayObject[] = [];

    // The user_ids_string for the current view, if any.
    const active_user_ids_string = get_active_user_ids_string();

    if (
        active_user_ids_string !== undefined &&
        !conversations
            .map((conversation) => conversation.user_ids_string)
            .includes(active_user_ids_string)
    ) {
        conversations.unshift({
            user_ids_string: active_user_ids_string,
            max_message_id: -1,
            local_message_count: 0,
        });
    }

    for (const conversation of conversations) {
        const user_ids_string = conversation.user_ids_string;

        const user_ids = people.user_ids_string_to_ids_array(user_ids_string);
        const users = people.get_users_from_ids(user_ids);
        if (!people.dm_matches_search_string(users, search_string)) {
            // Skip adding the conversation to the display_objects array if it does
            // not match the search_term.
            continue;
        }

        display_objects.push(get_display_object(user_ids_string, active_user_ids_string));
    }

    return display_objects;
}

export type SectionDisplayObject = {
    name: string;
    unread: number;
    conversations: DisplayObject[];
};

// The user's personal sections with the conversations to show in
// them, for the Chats tab of the left sidebar.
export function get_sections(search_string = ""): SectionDisplayObject[] {
    const active_user_ids_string = get_active_user_ids_string();
    const sections: SectionDisplayObject[] = [];

    for (const section of personal_sections.get_conversation_sections()) {
        // Searching for a section finds all of its conversations.
        const section_matches_search = util.prefix_match({
            value: section.name,
            search_term: search_string,
        });
        const conversations: DisplayObject[] = [];

        for (const user_ids_string of section.user_ids_strings) {
            const user_ids = people.user_ids_string_to_ids_array(user_ids_string);
            const users: User[] = [];
            for (const user_id of user_ids) {
                const user = people.maybe_get_user_by_id(user_id, true);
                if (user !== undefined) {
                    users.push(user);
                }
            }
            if (
                // The conversation stays in its section while one of
                // its users is not accessible.
                users.length !== user_ids.length ||
                // Mirrors how pm_conversations.ts hides conversations
                // with muted users.
                user_ids.every((user_id) => muted_users.is_user_muted(user_id)) ||
                (!section_matches_search && !people.dm_matches_search_string(users, search_string))
            ) {
                continue;
            }

            conversations.push(get_display_object(user_ids_string, active_user_ids_string));
        }

        if (search_string !== "" && conversations.length === 0) {
            continue;
        }

        sections.push({
            name: section.name,
            unread: conversations.reduce((sum, conversation) => sum + conversation.unread, 0),
            conversations,
        });
    }

    return sections;
}

// The conversations that are not in any of the user's personal sections.
export function get_unsectioned_conversations(search_string = ""): DisplayObject[] {
    const sectioned_user_ids_strings = new Set(
        personal_sections
            .get_conversation_sections()
            .flatMap((section) => section.user_ids_strings),
    );
    return get_conversations(search_string).filter(
        (conversation) => !sectioned_user_ids_strings.has(conversation.user_ids_string),
    );
}

// Designed to closely match topic_list_data.get_list_info().
export function get_list_info(
    zoomed: boolean,
    search_term = "",
): {
    conversations_to_be_shown: DisplayObject[];
    more_conversations_unread_count: number;
} {
    const conversations = get_conversations(search_term);

    if (zoomed) {
        return {
            conversations_to_be_shown: conversations,
            more_conversations_unread_count: 0,
        };
    }

    const conversations_to_be_shown = [];
    let more_conversations_unread_count = 0;

    function should_show_conversation(conversation: DisplayObject): boolean {
        const current_to_be_shown_count = conversations_to_be_shown.length;

        // We always show the active conversation; see the similar
        // comment in topic_list_data.ts.
        if (conversation.is_active) {
            return true;
        }

        // We don't need to filter muted users here, because
        // pm_conversations.ts takes care of this for us.

        // Conversations that include any deactivated users are
        // hidden from the unzoomed view to declutter the sidebar,
        // unless they have unread messages since that's still worth
        // showing.
        if (conversation.includes_deactivated_user && conversation.unread === 0) {
            return false;
        }

        // We include the most recent max_conversations_to_show
        // conversations, regardless of whether they have unread
        // messages.
        if (current_to_be_shown_count < max_conversations_to_show) {
            return true;
        }

        // We include older conversations with unread messages up
        // until max_conversations_to_show_with_unreads total
        // topics have been included.
        if (
            conversation.unread > 0 &&
            current_to_be_shown_count < max_conversations_to_show_with_unreads
        ) {
            return true;
        }

        // Otherwise, this conversation should only be visible in
        // the unzoomed view.
        return false;
    }

    for (const conversation of conversations) {
        if (should_show_conversation(conversation)) {
            conversations_to_be_shown.push(conversation);
        } else {
            more_conversations_unread_count += conversation.unread;
        }
    }

    return {
        conversations_to_be_shown,
        more_conversations_unread_count,
    };
}
