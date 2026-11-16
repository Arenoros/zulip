import {$} from "jquery";

import * as calendar_grid from "./calendar_grid.ts";
import type {CalendarOccurrence} from "./calendar_grid.ts";
import * as calendar_util from "./calendar_util.ts";
import * as channel from "./channel.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import {$t, $t_html} from "./i18n.ts";
import {current_user} from "./state_data.ts";
import * as ui_report from "./ui_report.ts";
import {user_settings} from "./user_settings.ts";
import * as util from "./util.ts";

// What the user can do with an event in their calendar, from its card
// or from the meeting opened on the whole window.

// The values of CalendarResponse on the server.
export const RESPONSES = new Map([
    ["none", 1],
    ["accepted", 2],
    ["tentative", 3],
    ["declined", 4],
    ["following", 5],
]);

export type Scope = "occurrence" | "series";

export function get_response_name(response: number): string {
    return [...RESPONSES].find(([, value]) => value === response)?.[0] ?? "none";
}

export function is_personal(occurrence: CalendarOccurrence): boolean {
    return occurrence.attendees.every((attendee) => attendee.user_id === current_user.user_id);
}

function format_day(date: Date): string {
    const time_zone = calendar_grid.get_time_zone();
    const weekday = new Intl.DateTimeFormat(user_settings.default_language, {
        weekday: "short",
        timeZone: time_zone,
    }).format(date);
    const day = new Intl.DateTimeFormat(user_settings.default_language, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: time_zone,
    }).format(date);
    return `${calendar_util.capitalize(weekday, user_settings.default_language)} ${day}`;
}

function format_time(date: Date): string {
    return new Intl.DateTimeFormat(user_settings.default_language, {
        hour: "numeric",
        minute: "2-digit",
        hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
        timeZone: calendar_grid.get_time_zone(),
    }).format(date);
}

// "Mon 11/09/2026 12:00 PM – 1:00 PM", with the day of the end too
// when it is another day.
export function get_time_label(occurrence: CalendarOccurrence): string {
    const start = new Date(occurrence.start * 1000);
    if (occurrence.is_all_day) {
        // All-day events end at the midnight after their last day.
        const last_day = new Date((occurrence.end - 1) * 1000);
        const first = format_day(start);
        const last = format_day(last_day);
        return first === last ? first : `${first} – ${last}`;
    }
    const end = new Date(occurrence.end * 1000);
    const start_day = format_day(start);
    const end_day = format_day(end);
    if (start_day === end_day) {
        return `${start_day} ${format_time(start)} – ${format_time(end)}`;
    }
    return `${start_day} ${format_time(start)} – ${end_day} ${format_time(end)}`;
}

export function get_scope_data(
    occurrence: CalendarOccurrence,
    scope: Scope,
): Record<string, string> {
    if (scope === "occurrence" && occurrence.original_start !== null) {
        return {occurrence: JSON.stringify(occurrence.original_start)};
    }
    return {};
}

// The organizer is told of the response, with the message, unless
// notify_organizer is false.
export function respond(
    occurrence: CalendarOccurrence,
    response: string,
    scope: Scope,
    notification: {notify_organizer: boolean; message: string},
    on_success: () => void,
    on_error: (xhr: JQuery.jqXHR) => void,
): void {
    void channel.post({
        url: `/json/calendar/events/${occurrence.id}/response`,
        data: {
            response: JSON.stringify(RESPONSES.get(response)),
            notify_organizer: JSON.stringify(notification.notify_organizer),
            message: notification.message,
            ...get_scope_data(occurrence, scope),
        },
        success() {
            on_success();
            calendar_grid.refresh();
        },
        error: on_error,
    });
}

function remove(occurrence: CalendarOccurrence, scope: Scope, on_removed: () => void): void {
    void channel.del({
        url: `/json/calendar/events/${occurrence.id}`,
        data: get_scope_data(occurrence, scope),
        success() {
            on_removed();
            calendar_grid.refresh();
        },
        error(xhr) {
            ui_report.error(
                $t_html({defaultMessage: "Failed to remove the event"}),
                xhr,
                $("#home-error"),
            );
        },
    });
}

// Cancels a meeting the user organizes, or removes the event from the
// user's calendar, after they confirm.
export function confirm_remove(
    occurrence: CalendarOccurrence,
    scope: Scope,
    on_removed: () => void = () => undefined,
): void {
    const is_organizer = occurrence.organizer_id === current_user.user_id;
    const is_meeting = !is_personal(occurrence);
    let title_html: string;
    let content: string;
    if (is_organizer && is_meeting) {
        title_html =
            scope === "occurrence"
                ? $t_html({defaultMessage: "Cancel this occurrence?"})
                : $t_html({defaultMessage: "Cancel this meeting?"});
        content = $t({defaultMessage: "Attendees will see it as canceled."});
    } else {
        title_html =
            scope === "occurrence"
                ? $t_html({defaultMessage: "Delete this occurrence?"})
                : $t_html({defaultMessage: "Delete this event?"});
        content = is_meeting
            ? $t({defaultMessage: "You will decline it, and it will leave your calendar."})
            : $t({defaultMessage: "This can't be undone."});
    }
    const $content = $("<p>").text(content);
    confirm_dialog.launch({
        modal_title_html: title_html,
        modal_content_html: util.the($content).outerHTML,
        is_compact: true,
        dangerous_action: true,
        on_click() {
            remove(occurrence, scope, on_removed);
        },
    });
}
