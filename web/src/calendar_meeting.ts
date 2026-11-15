import {TZDate} from "@date-fns/tz";
import {$} from "jquery";
import assert from "minimalistic-assert";
import * as z from "zod/mini";

import render_calendar_meeting from "../templates/calendar/calendar_meeting.hbs";
import render_calendar_card_choices_popover from "../templates/popovers/calendar/calendar_card_choices_popover.hbs";

import * as calendar_actions from "./calendar_actions.ts";
import * as calendar_form from "./calendar_form.ts";
import * as calendar_grid from "./calendar_grid.ts";
import type {CalendarOccurrence} from "./calendar_grid.ts";
import * as calendar_recurrence from "./calendar_recurrence.ts";
import * as calendar_responses from "./calendar_responses.ts";
import * as calendar_util from "./calendar_util.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import type {InputPillContainer} from "./input_pill.ts";
import * as people from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import * as popover_menus from "./popover_menus.ts";
import * as popovers from "./popovers.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import {current_user} from "./state_data.ts";
import * as timerender from "./timerender.ts";
import * as ui_util from "./ui_util.ts";
import * as user_pill from "./user_pill.ts";
import type {UserPill} from "./user_pill.ts";
import {user_settings} from "./user_settings.ts";

// A meeting the user is invited to, opened on the whole window from
// its card, in place of the calendar's grid.

// The attendees named before "and N more".
const MAX_NAMED_ATTENDEES = 2;
const MAX_LISTED_OCCURRENCES = 10;
// The longest range of events the server gives.
const OCCURRENCES_RANGE_DAYS = 60;

type Meeting = {
    occurrence: CalendarOccurrence;
    // Whether the meeting is a series as a whole, rather than one of
    // its occurrences or an event that does not repeat.
    is_series: boolean;
};

let meeting: Meeting | undefined;
let is_responses_shown = true;
let forward_pills: InputPillContainer<UserPill> | undefined;
let on_close: (() => void) | undefined;

const events_schema = z.object({events: z.array(calendar_grid.occurrence_schema)});
const event_schema = z.object({event: calendar_grid.occurrence_schema});

export function is_open(): boolean {
    return meeting !== undefined;
}

function get_attendees_label(occurrence: CalendarOccurrence): string {
    // The organizer comes first.
    const user_ids = [
        occurrence.organizer_id,
        ...occurrence.attendees
            .map((attendee) => attendee.user_id)
            .filter((user_id) => user_id !== occurrence.organizer_id),
    ];
    const names = user_ids
        .slice(0, MAX_NAMED_ATTENDEES)
        .map(
            (user_id) =>
                people.maybe_get_user_by_id(user_id, true)?.full_name ??
                $t({defaultMessage: "Unknown user"}),
        )
        .join("; ");
    const more = user_ids.length - MAX_NAMED_ATTENDEES;
    if (more <= 0) {
        return names;
    }
    return $t({defaultMessage: "{names}; {count} more"}, {names, count: more});
}

// The time of the call in the event's own timezone, as in "Repeats
// every Wednesday, 3:00 PM – 4:00 PM (UTC+03:00)".
function get_call_time_label(occurrence: CalendarOccurrence): string {
    const time_zone = occurrence.timezone;
    const start = new TZDate(occurrence.start * 1000, time_zone);
    const format_time = (date: Date): string =>
        new Intl.DateTimeFormat(user_settings.default_language, {
            hour: "numeric",
            minute: "2-digit",
            hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
            timeZone: time_zone,
        }).format(date);
    const time = occurrence.is_all_day
        ? $t({defaultMessage: "All day"})
        : `${format_time(start)} – ${format_time(new Date(occurrence.end * 1000))}`;
    const offset = timerender.get_utc_offset_string(time_zone, start);
    const recurrence = calendar_recurrence.parse_rrule(occurrence.rrule, time_zone);
    if (recurrence === undefined) {
        const date = calendar_recurrence.format_date_in_sentence(calendar_util.format_date(start));
        return `${calendar_util.capitalize(date, user_settings.default_language)}, ${time} (${offset})`;
    }
    return $t(
        {defaultMessage: "Repeats {pattern}, {time} ({offset})"},
        {
            pattern: calendar_recurrence.describe_pattern(
                recurrence,
                calendar_util.format_date(start),
            ),
            time,
            offset,
        },
    );
}

function get_time_label(occurrence: CalendarOccurrence, is_series: boolean): string {
    const recurrence = calendar_recurrence.parse_rrule(occurrence.rrule, occurrence.timezone);
    if (!is_series || recurrence === undefined) {
        return calendar_actions.get_time_label(occurrence);
    }
    const start = new TZDate(occurrence.start * 1000, occurrence.timezone);
    const format_minutes = (date: Date): string =>
        new Intl.DateTimeFormat(user_settings.default_language, {
            hour: "numeric",
            minute: "2-digit",
            hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
            timeZone: occurrence.timezone,
        }).format(date);
    return calendar_recurrence.describe(
        recurrence,
        calendar_util.format_date(start),
        occurrence.is_all_day
            ? undefined
            : {start: format_minutes(start), end: format_minutes(new Date(occurrence.end * 1000))},
    );
}

function get_context(current: Meeting): Record<string, unknown> {
    const {occurrence, is_series} = current;
    const response = calendar_actions.get_response_name(occurrence.response);
    const status = calendar_grid.get_free_busy_status(occurrence.show_as);
    const category_color = calendar_form.get_category_color(occurrence.category);
    const is_recurring = occurrence.rrule !== "";
    return {
        title: occurrence.is_cancelled
            ? $t({defaultMessage: "Canceled: {title}"}, {title: occurrence.title})
            : occurrence.title,
        is_cancelled: occurrence.is_cancelled,
        has_scope_choice: is_recurring && !is_series,
        responses: [
            {response: "accepted", icon: "check", label: $t({defaultMessage: "Accept"})},
            {response: "declined", icon: "close", label: $t({defaultMessage: "Decline"})},
            {response: "following", icon: "calendar-clock", label: $t({defaultMessage: "Follow meeting"})},
        ].map((button) => ({...button, is_selected: button.response === response})),
        can_forward: occurrence.allow_forwarding && !occurrence.is_cancelled,
        show_as_label: status.label,
        show_as_class: status.class_name,
        show_as_aria_label: $t({defaultMessage: "Show as: {status}"}, {status: status.label}),
        reminder_aria_label: $t(
            {defaultMessage: "Reminder: {reminder}"},
            {reminder: calendar_form.get_reminder_label(occurrence.reminder_minutes)},
        ),
        category_color,
        category_aria_label: $t(
            {defaultMessage: "Category: {category}"},
            {category: calendar_form.get_category_label(category_color || "none")},
        ),
        attendees_label: get_attendees_label(occurrence),
        time_label: get_time_label(occurrence, is_series),
        is_occurrence: is_recurring && !is_series,
        is_recurring,
        location: occurrence.location,
        has_zulip_call: occurrence.has_zulip_call,
        rendered_description: occurrence.rendered_description,
        call_time_label: get_call_time_label(occurrence),
    };
}

function render(): void {
    assert(meeting !== undefined);
    const current = meeting;
    $("#calendar-view").addClass("viewing-meeting");
    const $container = $("#calendar-view .calendar-meeting-container");
    $container.html(render_calendar_meeting(get_context(current)));
    rendered_markdown.update_elements($container.find(".calendar-meeting-description-text"));
    calendar_responses.render($container.find(".calendar-responses"), current.occurrence);
    update_responses_panel();
    const $forward = $container.find(".calendar-meeting-forward-people");
    if ($forward.length > 0) {
        forward_pills = user_pill.create_pills($forward, {exclude_inaccessible_users: true});
        pill_typeahead.set_up_user($forward.find(".input"), forward_pills, {
            exclude_bots: true,
            exclude_user_ids: [
                current_user.user_id,
                ...current.occurrence.attendees.map((attendee) => attendee.user_id),
            ],
        });
    }
}

function update_responses_panel(): void {
    const $view = $("#calendar-view .calendar-meeting");
    $view.find(".calendar-responses").toggleClass("hide", !is_responses_shown);
    $view
        .find(".calendar-meeting-responses-button")
        .attr("aria-expanded", String(is_responses_shown))
        .toggleClass("selected", is_responses_shown);
}

function show_error(xhr: JQuery.jqXHR): void {
    $("#calendar-view .calendar-meeting-error")
        .text(channel.xhr_error_message($t({defaultMessage: "Something went wrong"}), xhr))
        .addClass("shown");
}

function open_meeting(current: Meeting): void {
    meeting = current;
    forward_pills = undefined;
    render();
    $("#calendar-view .calendar-meeting-title").attr("tabindex", "-1").trigger("focus");
}

export function open(occurrence: CalendarOccurrence): void {
    open_meeting({occurrence, is_series: false});
}

function open_series(event_id: number): void {
    void channel.get({
        url: `/json/calendar/events/${event_id}`,
        success(raw_data) {
            open_meeting({occurrence: event_schema.parse(raw_data).event, is_series: true});
        },
        error: show_error,
    });
}

// Gets the meeting again after a change, or closes it if it left the
// user's calendar.
function reload(): void {
    assert(meeting !== undefined);
    const current = meeting;
    const {occurrence} = current;
    if (current.is_series) {
        open_series(occurrence.id);
        return;
    }
    void channel.get({
        url: "/json/calendar/events",
        data: {start: occurrence.start - 1, end: occurrence.end + 1},
        success(raw_data) {
            if (meeting !== current) {
                return;
            }
            const updated = events_schema
                .parse(raw_data)
                .events.find(
                    (event) =>
                        event.id === occurrence.id &&
                        event.original_start === occurrence.original_start,
                );
            if (updated === undefined) {
                close();
                return;
            }
            meeting = {occurrence: updated, is_series: false};
            render();
        },
        error: show_error,
    });
}

// Asks whether an action is for this occurrence or the whole series.
function choose_scope(
    button: HTMLElement,
    on_choose: (scope: calendar_actions.Scope) => void,
): void {
    assert(meeting !== undefined);
    if (meeting.is_series || meeting.occurrence.original_start === null) {
        on_choose("series");
        return;
    }
    show_choices(
        button,
        [
            {value: "occurrence", label: $t({defaultMessage: "This occurrence"})},
            {value: "series", label: $t({defaultMessage: "The whole series"})},
        ],
        (value) => {
            on_choose(value === "occurrence" ? "occurrence" : "series");
        },
    );
}

function show_choices(
    button: HTMLElement,
    choices: {value: string; label: string}[],
    on_choose: (value: string) => void,
): void {
    popover_menus.toggle_popover_menu(button, {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            instance.setContent(
                ui_util.parse_html(render_calendar_card_choices_popover({choices})),
            );
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            $(instance.popper).on("click", ".calendar-card-choice", function (this: HTMLElement, e) {
                e.preventDefault();
                popover_menus.hide_current_popover_if_visible(instance);
                on_choose(this.dataset["choice"]!);
            });
        },
        onHidden(instance) {
            instance.destroy();
        },
    });
}

function show_occurrences(button: HTMLElement): void {
    assert(meeting !== undefined);
    const {occurrence} = meeting;
    const now = Math.floor(Date.now() / 1000);
    void channel.get({
        url: "/json/calendar/events",
        data: {start: now, end: now + OCCURRENCES_RANGE_DAYS * 24 * 60 * 60},
        success(raw_data) {
            const occurrences = events_schema
                .parse(raw_data)
                .events.filter((event) => event.id === occurrence.id)
                .slice(0, MAX_LISTED_OCCURRENCES);
            if (occurrences.length === 0) {
                $("#calendar-view .calendar-meeting-error")
                    .text($t({defaultMessage: "No upcoming occurrences"}))
                    .addClass("shown");
                return;
            }
            show_choices(
                button,
                occurrences.map((event, index) => ({
                    value: String(index),
                    label: event.is_cancelled
                        ? $t(
                              {defaultMessage: "{time} (canceled)"},
                              {time: calendar_actions.get_time_label(event)},
                          )
                        : calendar_actions.get_time_label(event),
                })),
                (value) => {
                    open(occurrences[Number(value)]!);
                },
            );
        },
        error: show_error,
    });
}

function update_personal_settings(data: Record<string, string>): void {
    assert(meeting !== undefined);
    void channel.patch({
        url: `/json/calendar/events/${meeting.occurrence.id}/personal_settings`,
        data,
        success() {
            calendar_grid.refresh();
            reload();
        },
        error: show_error,
    });
}

function show_personal_menu(button: HTMLElement): void {
    assert(meeting !== undefined);
    const menu = button.dataset["menu"];
    assert(menu === "show_as" || menu === "reminder" || menu === "category");
    calendar_form.show_choice_menu(
        button,
        calendar_form.get_personal_menu_options(menu, meeting.occurrence),
        (value) => {
            switch (menu) {
                case "show_as":
                    update_personal_settings({show_as: value});
                    break;
                case "reminder":
                    update_personal_settings({
                        reminder_minutes: value === "" ? "null" : value,
                    });
                    break;
                case "category":
                    update_personal_settings({category: value});
                    break;
            }
        },
    );
}

function forward(): void {
    assert(meeting !== undefined && forward_pills !== undefined);
    const user_ids = user_pill.get_user_ids(forward_pills);
    if (user_ids.length === 0) {
        return;
    }
    void channel.post({
        url: `/json/calendar/events/${meeting.occurrence.id}/attendees`,
        data: {user_ids: JSON.stringify(user_ids)},
        success() {
            reload();
        },
        error: show_error,
    });
}

export function close(): void {
    meeting = undefined;
    forward_pills = undefined;
    $("#calendar-view").removeClass("viewing-meeting");
    $("#calendar-view .calendar-meeting-container").empty();
    on_close?.();
}

// Draws the meeting again when the calendar shows again.
export function restore(): void {
    if (meeting !== undefined) {
        render();
    }
}

export function initialize(opts: {on_close: () => void}): void {
    on_close = opts.on_close;
    const $view = $("#calendar-view");
    const selector = (child: string): string => `.calendar-meeting ${child}`;
    $view.on("click", selector(".calendar-meeting-close"), () => {
        close();
    });
    $view.on("keydown", ".calendar-meeting", (e) => {
        if (e.key === "Escape" && !popovers.any_active()) {
            e.preventDefault();
            close();
        }
    });
    $view.on("click", selector(".calendar-meeting-respond"), function (this: HTMLElement) {
        const response = this.dataset["response"]!;
        choose_scope(this, (scope) => {
            assert(meeting !== undefined);
            calendar_actions.respond(meeting.occurrence, response, scope, reload, show_error);
        });
    });
    $view.on("click", selector(".calendar-meeting-delete"), function (this: HTMLElement) {
        choose_scope(this, (scope) => {
            assert(meeting !== undefined);
            calendar_actions.confirm_remove(meeting.occurrence, scope, close);
        });
    });
    $view.on("click", selector(".calendar-meeting-forward-button"), function (this: HTMLElement) {
        const $row = $("#calendar-view .calendar-meeting-forward");
        const is_shown = $row.hasClass("hide");
        $row.toggleClass("hide", !is_shown);
        $(this).attr("aria-expanded", String(is_shown));
        if (is_shown) {
            $row.find(".input").trigger("focus");
        }
    });
    $view.on("click", selector(".calendar-meeting-forward-send"), () => {
        forward();
    });
    $view.on("click", selector(".calendar-meeting-copy"), () => {
        assert(meeting !== undefined);
        const {occurrence, is_series} = meeting;
        close();
        calendar_form.open_copy(occurrence, is_series);
    });
    $view.on("click", selector(".calendar-meeting-menu-button"), function (this: HTMLElement) {
        show_personal_menu(this);
    });
    $view.on("click", selector(".calendar-meeting-series"), () => {
        assert(meeting !== undefined);
        open_series(meeting.occurrence.id);
    });
    $view.on("click", selector(".calendar-meeting-occurrences"), function (this: HTMLElement) {
        show_occurrences(this);
    });
    for (const button of [".calendar-meeting-responses-button", ".calendar-responses-hide"]) {
        $view.on("click", selector(button), () => {
            is_responses_shown = !is_responses_shown;
            update_responses_panel();
        });
    }
}

