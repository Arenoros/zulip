import {$} from "jquery";
import assert from "minimalistic-assert";
import * as tippy from "tippy.js";

import render_calendar_card_choices_popover from "../templates/popovers/calendar/calendar_card_choices_popover.hbs";
import render_calendar_card_popover from "../templates/popovers/calendar/calendar_card_popover.hbs";

import * as calendar_actions from "./calendar_actions.ts";
import * as calendar_form from "./calendar_form.ts";
import * as calendar_grid from "./calendar_grid.ts";
import * as calendar_meeting from "./calendar_meeting.ts";
import * as calendar_meeting_chat from "./calendar_meeting_chat.ts";
import type {CalendarOccurrence} from "./calendar_grid.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import * as popover_menus from "./popover_menus.ts";
import {current_user} from "./state_data.ts";
import * as ui_util from "./ui_util.ts";

// The card of an event, which opens next to it on the grid.

let card_occurrence: CalendarOccurrence | undefined;
let choices_instance: tippy.Instance | undefined;

function get_counts_label(occurrence: CalendarOccurrence): string {
    const counts = new Map<string, number>();
    for (const attendee of occurrence.attendees) {
        if (attendee.user_id !== occurrence.organizer_id) {
            const name = calendar_actions.get_response_name(attendee.response);
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    const labels = [
        ["accepted", (count: number) => $t({defaultMessage: "Accepted: {count}"}, {count})],
        ["tentative", (count: number) => $t({defaultMessage: "Tentative: {count}"}, {count})],
        ["declined", (count: number) => $t({defaultMessage: "Declined: {count}"}, {count})],
        ["following", (count: number) => $t({defaultMessage: "Following: {count}"}, {count})],
        ["none", (count: number) => $t({defaultMessage: "Not answered: {count}"}, {count})],
    ] as const;
    return labels
        .filter(([name]) => counts.has(name))
        .map(([name, label]) => label(counts.get(name)!))
        .join(" · ");
}

function get_card_context(occurrence: CalendarOccurrence): Record<string, unknown> {
    const is_organizer = occurrence.organizer_id === current_user.user_id;
    const personal = is_organizer && calendar_actions.is_personal(occurrence);
    const organizer = people.maybe_get_user_by_id(occurrence.organizer_id, true);
    const title = occurrence.is_cancelled
        ? $t({defaultMessage: "Canceled: {title}"}, {title: occurrence.title})
        : occurrence.title;
    let organizer_label: string;
    if (is_organizer) {
        organizer_label = $t({defaultMessage: "You are the organizer"});
    } else {
        organizer_label = $t(
            {defaultMessage: "{name} invited you"},
            {name: organizer?.full_name ?? $t({defaultMessage: "Unknown user"})},
        );
    }
    let location = occurrence.location;
    if (location === "" && occurrence.has_zulip_call) {
        location = $t({defaultMessage: "Zulip call"});
    }
    return {
        title,
        is_organizer_of_meeting: is_organizer && !personal,
        is_personal: personal,
        is_invitee: !is_organizer && !occurrence.is_cancelled,
        is_recurring: occurrence.original_start !== null,
        time_label: calendar_actions.get_time_label(occurrence),
        location,
        organizer_label,
        organizer_avatar_url:
            organizer === undefined ? "" : people.small_avatar_url_for_person(organizer),
        counts_label: get_counts_label(occurrence),
        response: calendar_actions.get_response_name(occurrence.response),
    };
}

function get_card_instance(): tippy.Instance | null {
    return popover_menus.popover_instances.calendar_card;
}

function render_card(): void {
    const instance = get_card_instance();
    if (instance === null || card_occurrence === undefined) {
        return;
    }
    instance.setContent(ui_util.parse_html(render_calendar_card_popover(get_card_context(card_occurrence))));
}

function show_error(xhr: JQuery.jqXHR): void {
    const instance = get_card_instance();
    if (instance !== null) {
        $(instance.popper)
            .find(".calendar-card-error")
            .text(channel.xhr_error_message($t({defaultMessage: "Something went wrong"}), xhr))
            .addClass("shown");
    }
}

function hide_choices(): void {
    choices_instance?.destroy();
    choices_instance = undefined;
}

// Asks whether an action is for this occurrence or the whole series,
// in a menu under its button.
function choose_scope(button: HTMLElement, on_choose: (scope: calendar_actions.Scope) => void): void {
    assert(card_occurrence !== undefined);
    if (card_occurrence.original_start === null) {
        on_choose("series");
        return;
    }
    const instance = get_card_instance();
    assert(instance !== null);
    hide_choices();
    choices_instance = tippy.default(button, {
        ...popover_menus.default_popover_props,
        theme: "popover-menu",
        placement: "bottom-start",
        trigger: "manual",
        hideOnClick: false,
        appendTo: instance.popper,
        content: ui_util.parse_html(
            render_calendar_card_choices_popover({
                choices: [
                    {value: "occurrence", label: $t({defaultMessage: "This occurrence"})},
                    {value: "series", label: $t({defaultMessage: "The whole series"})},
                ],
            }),
        ),
    });
    $(choices_instance.popper).on("click", ".calendar-card-choice", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        const scope = this.dataset["choice"] === "occurrence" ? "occurrence" : "series";
        hide_choices();
        on_choose(scope);
    });
    choices_instance.show();
}

function respond(response: string, scope: calendar_actions.Scope): void {
    assert(card_occurrence !== undefined);
    const occurrence = card_occurrence;
    calendar_actions.respond(
        occurrence,
        response,
        scope,
        () => {
            if (card_occurrence === occurrence) {
                card_occurrence = {
                    ...occurrence,
                    response: calendar_actions.RESPONSES.get(response)!,
                };
                render_card();
            }
        },
        show_error,
    );
}

// The card is closed behind the confirmation.
function confirm_remove(scope: calendar_actions.Scope): void {
    assert(card_occurrence !== undefined);
    const occurrence = card_occurrence;
    hide();
    calendar_actions.confirm_remove(occurrence, scope);
}

function show_more_menu(button: HTMLElement): void {
    assert(card_occurrence !== undefined);
    const instance = get_card_instance();
    assert(instance !== null);
    hide_choices();
    const is_recurring = card_occurrence.original_start !== null;
    const choices = [
        {value: "follow", label: $t({defaultMessage: "Follow meeting"})},
        ...(is_recurring
            ? [
                  {value: "delete-occurrence", label: $t({defaultMessage: "Delete this occurrence"})},
                  {value: "delete-series", label: $t({defaultMessage: "Delete the whole series"})},
              ]
            : [{value: "delete-series", label: $t({defaultMessage: "Delete from my calendar"})}]),
    ];
    choices_instance = tippy.default(button, {
        ...popover_menus.default_popover_props,
        theme: "popover-menu",
        placement: "bottom-end",
        trigger: "manual",
        hideOnClick: false,
        appendTo: instance.popper,
        content: ui_util.parse_html(render_calendar_card_choices_popover({choices})),
    });
    $(choices_instance.popper).on("click", ".calendar-card-choice", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        const choice = this.dataset["choice"];
        hide_choices();
        if (choice === "follow") {
            respond("following", "series");
        } else {
            confirm_remove(choice === "delete-occurrence" ? "occurrence" : "series");
        }
    });
    choices_instance.show();
}

export function hide(): void {
    popover_menus.hide_current_popover_if_visible(get_card_instance());
}

function find_event_element(occurrence: CalendarOccurrence): HTMLElement | undefined {
    return $("#calendar-view .calendar-event[data-event-id]")
        .toArray()
        .find(
            (element) =>
                element.dataset["eventId"] === String(occurrence.id) &&
                element.dataset["originalStart"] === String(occurrence.original_start ?? ""),
        );
}

function open(element: HTMLElement): void {
    const event_id = Number(element.dataset["eventId"]);
    const original_start = element.dataset["originalStart"]
        ? Number(element.dataset["originalStart"])
        : null;
    const occurrence = calendar_grid.get_occurrence(event_id, original_start);
    if (occurrence === undefined) {
        return;
    }
    card_occurrence = occurrence;
    popover_menus.toggle_popover_menu(
        element,
        {
        theme: "popover-menu",
        placement: "right-start",
        // An answer draws the grid again, which replaces the event's
        // element; the card stays next to the new one.
        getReferenceClientRect: () =>
            (find_event_element(occurrence) ?? element).getBoundingClientRect(),
        popperOptions: {
            modifiers: [
                {name: "flip", options: {fallbackPlacements: ["left-start", "bottom", "top"]}},
            ],
        },
        onShow(instance) {
            popover_menus.popover_instances.calendar_card = instance;
            instance.setContent(
                ui_util.parse_html(render_calendar_card_popover(get_card_context(occurrence))),
            );
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            $popper.on("click", ".calendar-card-respond", function (this: HTMLElement) {
                const response = this.dataset["response"]!;
                if (response === "tentative") {
                    respond(response, "series");
                } else {
                    choose_scope(this, (scope) => {
                        respond(response, scope);
                    });
                }
            });
            $popper.on("click", ".calendar-card-edit", function (this: HTMLElement) {
                choose_scope(this, (scope) => {
                    assert(card_occurrence !== undefined);
                    const edited = card_occurrence;
                    hide();
                    calendar_form.open_edit(edited, scope === "occurrence");
                });
            });
            $popper.on("click", ".calendar-card-expand", function (this: HTMLElement) {
                assert(card_occurrence !== undefined);
                const expanded = card_occurrence;
                if (expanded.organizer_id === current_user.user_id) {
                    // The organizer changes the meeting, next to its
                    // attendees' responses.
                    choose_scope(this, (scope) => {
                        hide();
                        calendar_form.open_edit(
                            expanded,
                            scope === "occurrence",
                            !calendar_actions.is_personal(expanded),
                        );
                    });
                    return;
                }
                hide();
                calendar_meeting.open(expanded);
            });
            $popper.on("click", ".calendar-card-chat", () => {
                assert(card_occurrence !== undefined);
                calendar_meeting_chat.open(card_occurrence.id, $popper.find(".calendar-card-error"));
            });
            $popper.on("click", ".calendar-card-cancel", function (this: HTMLElement) {
                choose_scope(this, confirm_remove);
            });
            $popper.on("click", ".calendar-card-more", function (this: HTMLElement) {
                show_more_menu(this);
            });
        },
        onHidden(instance) {
            hide_choices();
            instance.destroy();
            popover_menus.popover_instances.calendar_card = null;
            card_occurrence = undefined;
        },
        },
        {
            // A card opened from the keyboard returns there, to the
            // event, which may have been drawn again.
            get_focus_return_element: () => find_event_element(occurrence) ?? element,
        },
    );
}

export function initialize(): void {
    $("#calendar-view").on("click", ".calendar-event[data-event-id]", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        open(this);
    });
}
