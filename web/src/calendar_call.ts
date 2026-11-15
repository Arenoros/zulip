import {$} from "jquery";
import * as z from "zod/mini";

import render_calendar_meet_now_dialog from "../templates/calendar/calendar_meet_now_dialog.hbs";

import * as calendar_grid from "./calendar_grid.ts";
import * as call_ringing from "./call_ringing.ts";
import * as channel from "./channel.ts";
import * as compose_call from "./compose_call.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import type {InputPillContainer} from "./input_pill.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import {current_user} from "./state_data.ts";
import * as ui_report from "./ui_report.ts";
import * as user_pill from "./user_pill.ts";
import type {UserPill} from "./user_pill.ts";

// The call of a meeting with a Zulip call takes place in the meeting's
// chat; joining it starts it if it is not taking place.

const MEET_NOW_MINUTES = 30;

export function can_join(occurrence: {has_zulip_call: boolean; is_cancelled: boolean}): boolean {
    return (
        occurrence.has_zulip_call &&
        !occurrence.is_cancelled &&
        compose_call.is_livekit_call_provider()
    );
}

function post_join(
    event_id: number,
    voice_only: boolean,
    call_window: ReturnType<typeof call_ringing.open_window_for_new_call>,
    on_error: (xhr: JQuery.jqXHR) => void,
): void {
    void channel.post({
        url: `/json/calendar/events/${event_id}/call`,
        data: {voice_only: JSON.stringify(voice_only)},
        success(data) {
            call_window.show(z.object({url: z.string()}).parse(data).url);
        },
        error(xhr) {
            call_window.close();
            on_error(xhr);
        },
    });
}

// Must be called in response to a click, which lets the call's
// window open.
export function join(event_id: number, voice_only: boolean, $error: JQuery): void {
    post_join(event_id, voice_only, call_ringing.open_window_for_new_call(), (xhr) => {
        ui_report.error($t_html({defaultMessage: "Failed to join the call"}), xhr, $error);
    });
}

let meet_now_pills: InputPillContainer<UserPill> | undefined;

function start_meet_now(): void {
    const title = $<HTMLInputElement>("#calendar-meet-now-title").val()?.trim() ?? "";
    const attendee_ids = meet_now_pills === undefined ? [] : user_pill.get_user_ids(meet_now_pills);
    const start = Math.floor(Date.now() / 1000);
    const call_window = call_ringing.open_window_for_new_call();
    const on_error = (xhr: JQuery.jqXHR): void => {
        call_window.close();
        dialog_widget.hide_dialog_spinner();
        ui_report.error(
            $t_html({defaultMessage: "Failed to start the call"}),
            xhr,
            $("#dialog_error"),
        );
    };
    void channel.post({
        url: "/json/calendar/events",
        data: {
            title: title === "" ? $t({defaultMessage: "Meet now"}) : title,
            start: JSON.stringify(start),
            end: JSON.stringify(start + MEET_NOW_MINUTES * 60),
            timezone: calendar_grid.get_time_zone(),
            has_zulip_call: JSON.stringify(true),
            required_attendees: JSON.stringify(attendee_ids),
            optional_attendees: JSON.stringify([]),
        },
        success(data) {
            const {id} = z.object({id: z.number()}).parse(data);
            post_join(id, false, call_window, (xhr) => {
                // The meeting is in the calendar; joining it from there
                // tries again.
                dialog_widget.close();
                ui_report.error(
                    $t_html({defaultMessage: "Failed to join the call"}),
                    xhr,
                    $("#home-error"),
                );
            });
            dialog_widget.close();
        },
        error: on_error,
    });
}

// "Meet now" schedules a meeting from now with a Zulip call, with the
// people chosen, and joins its call.
export function show_meet_now_dialog(): void {
    dialog_widget.launch({
        modal_title_html: $t_html({defaultMessage: "Meet now"}),
        modal_content_html: render_calendar_meet_now_dialog({
            title: $t({defaultMessage: "Meet now"}),
        }),
        modal_submit_button_text: $t({defaultMessage: "Join now"}),
        id: "calendar-meet-now-modal",
        form_id: "calendar-meet-now-form",
        loading_spinner: true,
        on_click: start_meet_now,
        post_render() {
            const $container = $("#calendar-meet-now-modal .calendar-meet-now-attendees");
            meet_now_pills = user_pill.create_pills($container, {exclude_inaccessible_users: true});
            pill_typeahead.set_up_user($container.find(".input"), meet_now_pills, {
                exclude_bots: true,
                exclude_user_ids: [current_user.user_id],
            });
        },
        on_shown() {
            $("#calendar-meet-now-modal .calendar-meet-now-attendees .input").trigger("focus");
        },
        on_hidden() {
            meet_now_pills = undefined;
        },
    });
}
