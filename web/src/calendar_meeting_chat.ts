import {$} from "jquery";
import assert from "minimalistic-assert";

import render_left_sidebar_meeting_chat_popover from "../templates/popovers/left_sidebar/left_sidebar_meeting_chat_popover.hbs";

import * as calendar_actions from "./calendar_actions.ts";
import * as calendar_grid from "./calendar_grid.ts";
import * as channel from "./channel.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import {$t_html} from "./i18n.ts";
import * as people from "./people.ts";
import * as popover_menus from "./popover_menus.ts";
import * as sub_store from "./sub_store.ts";
import type {StreamSubscription} from "./sub_store.ts";
import * as subscriber_api from "./subscriber_api.ts";
import * as ui_report from "./ui_report.ts";
import * as ui_util from "./ui_util.ts";

// The chat of a meeting is a private channel without topics, which
// the server creates when someone first opens it and which is shown
// among direct message conversations.

// How far ahead the header of a meeting's chat looks for its next
// occurrence; the longest range the server allows.
const NEXT_OCCURRENCE_DAYS = 62;

// The time of the next occurrence of the meeting of each chat, or ""
// if it has none soon, once fetched.
const next_time_labels = new Map<number, string>();
const fetching_chat_ids = new Set<number>();

// The time of the meeting's next occurrence, for the header of its
// chat: undefined until it is fetched, when on_fetched is called.
export function get_next_time_label(stream_id: number, on_fetched: () => void): string | undefined {
    const label = next_time_labels.get(stream_id);
    if (label !== undefined || fetching_chat_ids.has(stream_id)) {
        return label;
    }
    fetching_chat_ids.add(stream_id);
    const now = Math.floor(Date.now() / 1000);
    void channel.get({
        url: "/json/calendar/events",
        data: {start: now, end: now + NEXT_OCCURRENCE_DAYS * 24 * 60 * 60},
        success(data) {
            const next = calendar_grid.events_schema
                .parse(data)
                .events.filter(
                    (occurrence) => occurrence.chat_id === stream_id && !occurrence.is_cancelled,
                )
                .toSorted((a, b) => a.start - b.start)[0];
            next_time_labels.set(
                stream_id,
                next === undefined ? "" : calendar_actions.get_time_label(next),
            );
            fetching_chat_ids.delete(stream_id);
            on_fetched();
        },
        error() {
            fetching_chat_ids.delete(stream_id);
        },
    });
    return undefined;
}

// Changes to meetings may change when they next take place.
export function clear_next_time_labels(): void {
    next_time_labels.clear();
}

// Leaving the chat unsubscribes the user; opening it from the meeting
// brings them back.
function confirm_leave(sub: StreamSubscription): void {
    confirm_dialog.launch({
        modal_title_html: $t_html({defaultMessage: "Leave {name}?"}, {name: sub.name}),
        modal_content_html: $t_html({
            defaultMessage: "You can return to the chat with Discussion in the meeting.",
        }),
        is_compact: true,
        id: "leave_meeting_chat_modal",
        on_click() {
            subscriber_api.remove_user_id_from_stream(
                people.my_current_user_id(),
                sub,
                () => {
                    // The client learns it left from the server's event.
                },
                (xhr) => {
                    ui_report.error(
                        $t_html({defaultMessage: "Failed to leave the chat"}),
                        xhr,
                        $("#home-error"),
                    );
                },
            );
        },
    });
}

export function initialize(): void {
    popover_menus.register_popover_menu(
        "#direct-messages-list .meeting-chat-sidebar-menu-icon, #modal-direct-messages-list .meeting-chat-sidebar-menu-icon",
        {
            ...popover_menus.left_sidebar_tippy_options,
            onShow(instance) {
                popover_menus.popover_instances.meeting_chat_actions = instance;
                ui_util.show_left_sidebar_menu_icon(instance.reference);
                popover_menus.on_show_prep(instance);
                instance.setContent(ui_util.parse_html(render_left_sidebar_meeting_chat_popover()));
                return undefined;
            },
            onMount(instance) {
                const stream_id = Number(
                    $(instance.reference).closest(".meeting-chat-list-item").attr("data-stream-id"),
                );
                const sub = sub_store.get(stream_id);
                assert(sub !== undefined);
                $(instance.popper).one("click", ".meeting-chat-popover-leave", () => {
                    popover_menus.hide_current_popover_if_visible(instance);
                    confirm_leave(sub);
                });
                popover_menus.focus_popover(instance);
            },
            onHidden(instance) {
                ui_util.hide_left_sidebar_menu_icon();
                instance.destroy();
                popover_menus.popover_instances.meeting_chat_actions = null;
            },
        },
        {also_trigger_on_enter: true},
    );
}
