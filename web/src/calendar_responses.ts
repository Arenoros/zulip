import {$} from "jquery";

import render_calendar_responses from "../templates/calendar/calendar_responses.hbs";

import * as calendar_actions from "./calendar_actions.ts";
import * as calendar_grid from "./calendar_grid.ts";
import type {CalendarOccurrence} from "./calendar_grid.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import {current_user} from "./state_data.ts";
import {user_settings} from "./user_settings.ts";

// The attendees' responses to a meeting, by response, in a panel next
// to the meeting or its form.

// Larger groups start collapsed, so that a meeting with hundreds of
// attendees shows its groups first.
const MAX_EXPANDED_GROUP_SIZE = 50;

function get_name(user_id: number): string {
    return (
        people.maybe_get_user_by_id(user_id, true)?.full_name ??
        $t({defaultMessage: "Unknown user"})
    );
}

function get_avatar_url(user_id: number): string {
    const person = people.maybe_get_user_by_id(user_id, true);
    return person === undefined ? "" : people.small_avatar_url_for_person(person);
}

function get_group_label(response: string, count: number): string {
    switch (response) {
        case "accepted":
            return $t({defaultMessage: "Accepted: {count}"}, {count});
        case "tentative":
            return $t({defaultMessage: "Tentative: {count}"}, {count});
        case "declined":
            return $t({defaultMessage: "Declined: {count}"}, {count});
        case "following":
            return $t({defaultMessage: "Following: {count}"}, {count});
        default:
            return $t({defaultMessage: "Not answered: {count}"}, {count});
    }
}

function get_own_status(response: string): string {
    switch (response) {
        case "accepted":
            return $t({defaultMessage: "You accepted"});
        case "tentative":
            return $t({defaultMessage: "You accepted tentatively"});
        case "declined":
            return $t({defaultMessage: "You declined"});
        case "following":
            return $t({defaultMessage: "You are following"});
        default:
            return $t({defaultMessage: "You haven't responded"});
    }
}

function get_sent_label(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return $t(
        {defaultMessage: "Sent {date} at {time}"},
        {
            date: new Intl.DateTimeFormat(user_settings.default_language, {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                timeZone: calendar_grid.get_time_zone(),
            }).format(date),
            time: new Intl.DateTimeFormat(user_settings.default_language, {
                hour: "numeric",
                minute: "2-digit",
                hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
                timeZone: calendar_grid.get_time_zone(),
            }).format(date),
        },
    );
}

export function render($container: JQuery, occurrence: CalendarOccurrence): void {
    const is_organizer = occurrence.organizer_id === current_user.user_id;
    const attendees = occurrence.attendees.filter(
        (attendee) => attendee.user_id !== occurrence.organizer_id,
    );
    const groups = ["accepted", "tentative", "declined", "following", "none"].flatMap(
        (response) => {
            const group = attendees
                .filter(
                    (attendee) =>
                        calendar_actions.get_response_name(attendee.response) === response,
                )
                .map((attendee) => ({
                    name: get_name(attendee.user_id),
                    avatar_url: get_avatar_url(attendee.user_id),
                    role: $t(
                        {
                            defaultMessage:
                                "{is_required, select, true {Required attendee} other {Optional attendee}}",
                        },
                        {is_required: String(attendee.is_required)},
                    ),
                    // Only the organizer sees who forwarded the
                    // invitation.
                    added_by:
                        is_organizer && attendee.added_by !== null
                            ? $t(
                                  {defaultMessage: "Added by {name}"},
                                  {name: get_name(attendee.added_by)},
                              )
                            : undefined,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            if (group.length === 0) {
                return [];
            }
            return [
                {
                    response,
                    label: get_group_label(response, group.length),
                    is_collapsed: group.length > MAX_EXPANDED_GROUP_SIZE,
                    people: group,
                },
            ];
        },
    );
    $container.html(
        render_calendar_responses({
            organizer: {
                name: get_name(occurrence.organizer_id),
                avatar_url: get_avatar_url(occurrence.organizer_id),
                sent_label: get_sent_label(occurrence.date_created),
            },
            own_status: is_organizer
                ? undefined
                : get_own_status(calendar_actions.get_response_name(occurrence.response)),
            // The organizer may hide the attendees from those invited.
            is_hidden: !is_organizer && occurrence.hide_attendees,
            groups,
        }),
    );
}

export function initialize(): void {
    $("#calendar-view").on(
        "click",
        ".calendar-responses-group-toggle",
        function (this: HTMLElement) {
            const $group = $(this).closest(".calendar-responses-group");
            const is_collapsed = !$group.hasClass("collapsed");
            $group.toggleClass("collapsed", is_collapsed);
            $(this).attr("aria-expanded", String(!is_collapsed));
        },
    );
}
