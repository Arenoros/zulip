import {$} from "jquery";
import assert from "minimalistic-assert";

import render_conversation_header from "../templates/conversation_header.hbs";
import render_message_view_header from "../templates/message_view_header.hbs";

import * as bubble_layout from "./bubble_layout.ts";
import * as buddy_data from "./buddy_data.ts";
import type {Filter} from "./filter.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as inbox_util from "./inbox_util.ts";
import * as muted_users from "./muted_users.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as peer_data from "./peer_data.ts";
import * as people from "./people.ts";
import type {User} from "./people.ts";
import * as recent_view_util from "./recent_view_util.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import * as search from "./search.ts";
import {current_user, realm} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import type {StreamSubscription} from "./sub_store.ts";
import * as util from "./util.ts";

type ConversationHeaderContext = {
    title: string;
    avatar_urls: string[];
    is_group: boolean;
    user_circle_class: string | undefined;
    subtitle: string;
};

type MessageViewHeaderContext = {
    title?: string | undefined;
    title_html?: string | undefined;
    description?: string;
    link?: string;
    is_spectator?: boolean;
    sub_count?: string | number;
    formatted_sub_count?: string;
    rendered_narrow_description?: string;
    is_admin?: boolean;
    stream?: StreamSubscription;
    stream_settings_link?: string;
    conversation_header?: ConversationHeaderContext;
} & (
    | {
          zulip_icon: string;
      }
    | {
          icon: string | undefined;
      }
);

// In the bubble layout, the header of a direct message conversation
// shows who it is with, as avatars, and their status.
function get_conversation_header_context(filter: Filter): ConversationHeaderContext | undefined {
    if (!bubble_layout.is_bubble_layout(filter)) {
        return undefined;
    }
    const user_ids = filter.terms_with_operator("dm")[0]!.operand;
    const users: User[] = [];
    for (const user_id of user_ids) {
        const user = people.maybe_get_user_by_id(user_id, true);
        // Unknown and muted users keep the classic header, which shows
        // nothing about them beyond a placeholder name.
        if (user === undefined || user.is_inaccessible_user || muted_users.is_user_muted(user_id)) {
            return undefined;
        }
        users.push(user);
    }
    const title = filter.get_title();
    assert(title !== undefined);
    const direct_messages = $t({defaultMessage: "Direct messages"});

    if (users.length > 1) {
        const strcmp = util.make_strcmp();
        users.sort((a, b) => strcmp(a.full_name, b.full_name));
        const participants = $t(
            {defaultMessage: "{N, plural, one {# participant} other {# participants}}"},
            {N: users.length + 1},
        );
        return {
            title,
            avatar_urls: users.slice(0, 2).map((user) => people.small_avatar_url_for_person(user)),
            is_group: true,
            user_circle_class: undefined,
            subtitle: `${$t({defaultMessage: "Group chat"})} · ${participants}`,
        };
    }

    const user = util.the(users);
    const context = {
        title,
        avatar_urls: [people.small_avatar_url_for_person(user)],
        is_group: false,
    };
    if (people.is_my_user_id(user.user_id)) {
        return {...context, user_circle_class: undefined, subtitle: direct_messages};
    }
    if (!people.is_person_active(user.user_id)) {
        const deactivated = user.is_bot
            ? $t({defaultMessage: "This bot has been deactivated."})
            : $t({defaultMessage: "This user has been deactivated."});
        return {
            ...context,
            user_circle_class: buddy_data.get_user_circle_class(user.user_id, true),
            subtitle: `${direct_messages} · ${deactivated}`,
        };
    }
    if (user.is_bot) {
        return {
            ...context,
            user_circle_class: undefined,
            subtitle: `${direct_messages} · ${$t({defaultMessage: "Bot"})}`,
        };
    }
    if (realm.realm_presence_disabled) {
        return {...context, user_circle_class: undefined, subtitle: direct_messages};
    }
    return {
        ...context,
        user_circle_class: buddy_data.get_user_circle_class(user.user_id),
        subtitle: `${direct_messages} · ${buddy_data.user_last_seen_time_status(user.user_id)}`,
    };
}

function get_message_view_header_context(filter: Filter | undefined): MessageViewHeaderContext {
    if (recent_view_util.is_visible()) {
        return {
            title: $t({defaultMessage: "Recent conversations"}),
            description: $t({defaultMessage: "Overview of ongoing conversations."}),
            zulip_icon: "recent",
            link: "/help/recent-conversations",
        };
    }

    if (inbox_util.is_visible() && !inbox_util.is_channel_view()) {
        return {
            title: $t({defaultMessage: "Inbox"}),
            description: $t({
                defaultMessage: "Overview of your conversations with unread messages.",
            }),
            zulip_icon: "inbox",
            link: "/help/inbox",
        };
    }

    // TODO: If we're not in the recent or inbox view, there should be
    // a message feed with a declared filter in the center pane. But
    // because of an initialization order bug, this function gets
    // called with a filter of `undefined` when loading the web app
    // with, say, inbox as the home view.
    //
    // TODO: Refactor this function to move the inbox/recent cases
    // into the caller, and this function can always get a Filter object.
    //
    // TODO: This ideally doesn't need a special case, we can just use
    // `filter.get_description` for it.
    if (filter === undefined || filter.is_in_home()) {
        let description;
        if (page_params.is_spectator) {
            description = $t({
                defaultMessage: "All your messages.",
            });
        } else {
            description = $t({
                defaultMessage: "All your messages except those in muted channels and topics.",
            });
        }
        return {
            title: $t({defaultMessage: "Combined feed"}),
            description,
            zulip_icon: "all-messages",
            link: "/help/combined-feed",
        };
    }

    const title = filter.get_title();
    const description = filter.get_description()?.description;
    const link = filter.get_description()?.link;
    assert(title !== undefined);
    const context = filter.add_icon_data({
        title,
        description,
        link,
        is_spectator: page_params.is_spectator,
    });

    const conversation_header = get_conversation_header_context(filter);
    if (conversation_header) {
        return {...context, conversation_header};
    }

    if (filter.has_operator("channel")) {
        const current_stream = stream_data.get_sub_by_id_string(
            filter.terms_with_operator("channel")[0]!.operand,
        );
        if (!current_stream) {
            return {
                ...context,
                sub_count: "0",
                formatted_sub_count: "0",
                rendered_narrow_description: $t({
                    defaultMessage: "This channel does not exist or is private.",
                }),
            };
        }

        // We can now be certain that the narrow
        // involves a stream which exists and
        // the current user can access.
        const sub_count = peer_data.get_subscriber_count(current_stream.stream_id);
        return {
            ...context,
            is_admin: current_user.is_admin,
            rendered_narrow_description: current_stream.rendered_description,
            sub_count,
            stream: current_stream,
            stream_settings_link: hash_util.channels_settings_edit_url(current_stream, "general"),
        };
    }

    return context;
}

export function colorize_message_view_header(): void {
    const current_sub = narrow_state.stream_sub();
    if (!current_sub) {
        return;
    }
    $("#message_view_header .navbar-icon").css("color", current_sub.color);
}

function append_and_display_title_area(context: MessageViewHeaderContext): void {
    const $message_view_header_elem = $("#message_view_header");
    $message_view_header_elem.html(render_message_view_header(context));
    if (context.stream_settings_link) {
        colorize_message_view_header();
    }
    $message_view_header_elem.removeClass("notdisplayed");
    const $content = $message_view_header_elem.find("span.rendered_markdown");
    if ($content) {
        // Update syntax like stream names, emojis, mentions, timestamps.
        rendered_markdown.update_elements($content);
    }
}

function build_message_view_header(filter: Filter | undefined): void {
    // This makes sure we don't waste time appending
    // message_view_header on a template where it's never used
    if (filter && !filter.is_common_narrow()) {
        search.open_search_bar_and_close_narrow_description();
    } else {
        const context = get_message_view_header_context(filter);
        append_and_display_title_area(context);
        search.close_search();
    }
}

export function initialize(): void {
    render_title_area();

    const hide_stream_settings_button_width_threshold = 620;
    $("body").on("mouseenter mouseleave", ".narrow_description", function (event) {
        const $view_description_elt = $(this);
        const window_width = $(window).width()!;
        let hover_timeout;

        if (event.type === "mouseenter") {
            if (!$view_description_elt.hasClass("view-description-extended")) {
                const current_width = $view_description_elt.outerWidth();
                // Set fixed width for word-wrap to work
                $view_description_elt.css("width", current_width + "px");
            }
            hover_timeout = setTimeout(() => {
                $view_description_elt.addClass("view-description-extended");
                $(".top-navbar-container").addClass(
                    "top-navbar-container-allow-description-extension",
                );

                if (window_width <= hide_stream_settings_button_width_threshold) {
                    $(".message-header-stream-settings-button").hide();
                    // Let it expand naturally on smaller screens
                    $view_description_elt.css("width", "");
                }
            }, 250);
            $view_description_elt.data("hover_timeout", hover_timeout);
        } else if (event.type === "mouseleave") {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            hover_timeout = $view_description_elt.data("hover_timeout");
            if (typeof hover_timeout === "number") {
                // Clear any pending hover_timeout to prevent unexpected behavior
                clearTimeout(hover_timeout);
            }
            $view_description_elt.addClass("leaving-extended-view-description");

            // Wait for the reverse animation duration before cleaning up
            setTimeout(() => {
                $view_description_elt.removeClass("view-description-extended");
                $view_description_elt.removeClass("leaving-extended-view-description");
                if (window_width <= hide_stream_settings_button_width_threshold) {
                    $(".message-header-stream-settings-button").show();
                    $view_description_elt.css("width", "");
                } else {
                    // Reset to flexbox-determined width
                    $view_description_elt.css("width", "");
                }
            }, 100);
        }
    });
}

export function render_title_area(): void {
    const filter = narrow_state.filter();
    build_message_view_header(filter);
}

// This function checks if "modified_sub" which is the stream whose values
// have been updated is the same as the stream which is currently
// narrowed and rerenders if necessary
export function maybe_rerender_title_area_for_stream(modified_stream_id: number): void {
    const current_stream_id = narrow_state.stream_id();

    if (current_stream_id === modified_stream_id) {
        render_title_area();
    }
}

// The navbar title shows a user's name when narrowed to a DM that
// includes them or to messages sent by them, so we refresh it for a
// rename of such a user.
export function maybe_update_navbar_title_for_user(modified_user_id: number): void {
    const filter = narrow_state.filter();
    if (filter === undefined) {
        return;
    }
    // Only common narrows show a name in the title; others show a search
    // bar and have no title to update.
    if (!filter.is_common_narrow()) {
        return;
    }
    const narrowed_to_dm_with_user = narrow_state.pm_ids_set(filter).has(modified_user_id);
    const sender_id = filter.terms_with_operator("sender")[0]?.operand;
    const narrowed_to_messages_sent_by_user = sender_id === modified_user_id;

    if (narrowed_to_dm_with_user || narrowed_to_messages_sent_by_user) {
        // Update just the title text rather than rebuilding the whole
        // header with render_title_area(), which would close or reset a
        // search bar the user has open to refine the narrow. For these
        // narrows the title is plain text and the icon doesn't depend on
        // the renamed user.
        const title = filter.get_title();
        assert(title !== undefined);
        $("#message_view_header .message-header-navbar-title").text(title);
    }
}

// Updates the conversation header for a change to the presence, avatar
// or account of one of its participants, or of everyone's presence if
// no user is given. Only the conversation header is replaced, because
// rebuilding the whole header would close a search the user has open
// to refine the narrow.
export function maybe_update_conversation_header(user_id?: number): void {
    const $conversation_header = $("#message_view_header .conversation-header");
    const filter = narrow_state.filter();
    if ($conversation_header.length === 0 || filter === undefined) {
        return;
    }
    if (user_id !== undefined && !narrow_state.pm_ids_set(filter).has(user_id)) {
        return;
    }
    const context = get_conversation_header_context(filter);
    if (context !== undefined) {
        $conversation_header.replaceWith($(render_conversation_header(context)));
    }
}
