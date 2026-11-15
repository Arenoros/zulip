import {TZDate} from "@date-fns/tz";
import {addDays, addMonths, format} from "date-fns";
import {$} from "jquery";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";
import * as z from "zod/mini";

import render_calendar_day_events from "../templates/calendar/calendar_day_events.hbs";
import render_calendar_form from "../templates/calendar/calendar_form.hbs";
import render_calendar_form_day from "../templates/calendar/calendar_form_day.hbs";
import render_calendar_form_suggestions from "../templates/calendar/calendar_form_suggestions.hbs";
import render_calendar_date_picker_popover from "../templates/popovers/calendar/calendar_date_picker_popover.hbs";
import render_calendar_form_attendee_options_popover from "../templates/popovers/calendar/calendar_form_attendee_options_popover.hbs";
import render_calendar_submenu_popover from "../templates/popovers/calendar/calendar_submenu_popover.hbs";
import timezones from "../generated/timezones.json";

import * as calendar_grid from "./calendar_grid.ts";
import type {CalendarOccurrence} from "./calendar_grid.ts";
import * as calendar_layout from "./calendar_layout.ts";
import * as calendar_recurrence from "./calendar_recurrence.ts";
import type {Recurrence} from "./calendar_recurrence.ts";
import * as calendar_util from "./calendar_util.ts";
import * as channel from "./channel.ts";
import * as compose_ui from "./compose_ui.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import * as dropdown_widget from "./dropdown_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import type {InputPillContainer} from "./input_pill.ts";
import * as people from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import * as popover_menus from "./popover_menus.ts";
import * as popovers from "./popovers.ts";
import * as rendered_markdown from "./rendered_markdown.ts";
import {current_user} from "./state_data.ts";
import * as timerender from "./timerender.ts";
import * as ui_report from "./ui_report.ts";
import * as ui_util from "./ui_util.ts";
import * as user_pill from "./user_pill.ts";
import type {UserPill} from "./user_pill.ts";
import {user_settings} from "./user_settings.ts";

// The form for a new event, and for changing one, which takes the
// place of the calendar's grid until it is saved or canceled.

// The values of CalendarShowAs on the server.
const SHOW_AS_BUSY = 3;
const MINUTES_PER_DAY = 24 * 60;
const TIME_STEP_MINUTES = 30;
// The step of moving and resizing the event on the day grid.
const DRAG_STEP_MINUTES = 15;
const MAX_SUGGESTIONS = 5;
// The occurrences of a series checked for suggested times, within the
// longest range of free/busy times the server gives.
const MAX_CHECKED_OCCURRENCES = 8;
const MAX_CHECKED_DAYS = 60;
// Free and working elsewhere.
const FREE_SHOW_AS = new Set([1, 5]);
const REMINDERS: (number | null)[] = [null, 0, 5, 15, 30, 60, 120, 720, 1440, 10_080];
// Outlook's default color categories, by the names Exchange stores.
const CATEGORIES = [
    ["Blue category", "blue"],
    ["Green category", "green"],
    ["Orange category", "orange"],
    ["Purple category", "purple"],
    ["Red category", "red"],
    ["Yellow category", "yellow"],
] as const;

type FormState = {
    title: string;
    required_attendee_ids: number[];
    optional_attendee_ids: number[];
    // The start's date and minute after midnight, in the event's
    // timezone, and the duration, which may end on the next day.
    date: string;
    start_minute: number;
    duration_minutes: number;
    time_zone: string;
    is_all_day: boolean;
    // Undefined for an event that does not repeat.
    recurrence: Recurrence | undefined;
    location: string;
    has_zulip_call: boolean;
    description: string;
    show_as: number;
    reminder_minutes: number | null;
    category: string;
    is_private: boolean;
    response_requested: boolean;
    allow_forwarding: boolean;
    hide_attendees: boolean;
};

type Editing = {
    occurrence: CalendarOccurrence;
    // Whether only this occurrence of a series changes.
    is_occurrence: boolean;
};

let state: FormState | undefined;
let initial_state: string | undefined;
let editing: Editing | undefined;
// Whether changing when the series takes place drops changes made to
// some of its occurrences.
let has_changed_occurrences = false;
let is_time_expanded = false;
let is_saving = false;
let required_pills: InputPillContainer<UserPill> | undefined;
let optional_pills: InputPillContainer<UserPill> | undefined;
let menu_instance: tippy.Instance | undefined;
let on_close: (() => void) | undefined;
let get_mini_month_context: ((month: Date) => Record<string, unknown>) | undefined;
let day_request_id = 0;
let suggestions_request_id = 0;

const day_events_schema = z.object({
    events: z.array(
        z.object({
            id: z.number(),
            start: z.number(),
            end: z.number(),
            timezone: z.string(),
            is_all_day: z.boolean(),
            title: z.string(),
        }),
    ),
});

export function is_open(): boolean {
    return state !== undefined;
}

function format_minutes(minutes: number): string {
    return new Intl.DateTimeFormat(user_settings.default_language, {
        hour: "numeric",
        minute: "2-digit",
        hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
        timeZone: "UTC",
    }).format(new Date(Date.UTC(2000, 0, 1, 0, minutes % MINUTES_PER_DAY)));
}

function get_start_seconds(form: FormState): number {
    const [year, month, day] = form.date.split("-").map(Number);
    return (
        new TZDate(
            year!,
            month! - 1,
            day!,
            0,
            form.is_all_day ? 0 : form.start_minute,
            form.time_zone,
        ).getTime() / 1000
    );
}

function get_end_seconds(form: FormState): number {
    if (form.is_all_day) {
        return calendar_layout.get_day_start(form.date, form.time_zone, 1);
    }
    const [year, month, day] = form.date.split("-").map(Number);
    return (
        new TZDate(
            year!,
            month! - 1,
            day!,
            0,
            form.start_minute + form.duration_minutes,
            form.time_zone,
        ).getTime() / 1000
    );
}

function get_date_label(date: string): string {
    const day = calendar_util.parse_date(date)!;
    const weekday = new Intl.DateTimeFormat(user_settings.default_language, {
        weekday: "short",
    }).format(day);
    const numeric = new Intl.DateTimeFormat(user_settings.default_language, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(day);
    return `${calendar_util.capitalize(weekday, user_settings.default_language)} ${numeric}`;
}

function get_long_date_label(date: string): string {
    const day = calendar_util.parse_date(date)!;
    return calendar_util.capitalize(
        new Intl.DateTimeFormat(user_settings.default_language, {
            weekday: "short",
            day: "numeric",
            month: "long",
            year: "numeric",
        }).format(day),
        user_settings.default_language,
    );
}

function get_show_as_label(show_as: number): string {
    return calendar_grid.get_free_busy_status(show_as).label;
}

export function get_reminder_label(minutes: number | null): string {
    if (minutes === null) {
        return $t({defaultMessage: "Don't remind me"});
    }
    if (minutes === 0) {
        return $t({defaultMessage: "When it starts"});
    }
    if (minutes % 10_080 === 0) {
        return $t(
            {defaultMessage: "{count, plural, one {# week before} other {# weeks before}}"},
            {count: minutes / 10_080},
        );
    }
    if (minutes % 1440 === 0) {
        return $t(
            {defaultMessage: "{count, plural, one {# day before} other {# days before}}"},
            {count: minutes / 1440},
        );
    }
    if (minutes % 60 === 0) {
        return $t(
            {defaultMessage: "{count, plural, one {# hour before} other {# hours before}}"},
            {count: minutes / 60},
        );
    }
    return $t(
        {defaultMessage: "{count, plural, one {# minute before} other {# minutes before}}"},
        {count: minutes},
    );
}

export function get_category_label(color: string): string {
    return $t(
        {
            defaultMessage:
                "{color, select, red {Red category} orange {Orange category} yellow {Yellow category} green {Green category} blue {Blue category} purple {Purple category} other {No category}}",
        },
        {color},
    );
}

function get_visibility_label(is_private: boolean): string {
    return $t(
        {defaultMessage: "{is_private, select, true {Private} other {Not private}}"},
        {is_private: String(is_private)},
    );
}

function get_attendee_ids(pills: InputPillContainer<UserPill> | undefined): number[] {
    return pills === undefined ? [] : user_pill.get_user_ids(pills);
}

function read_fields(): void {
    assert(state !== undefined);
    const $form = $("#calendar-view .calendar-form");
    state.title = $form.find<HTMLInputElement>(".calendar-form-title").val() ?? "";
    state.location = $form.find<HTMLInputElement>(".calendar-form-location").val() ?? "";
    state.description =
        $form.find<HTMLTextAreaElement>(".calendar-form-description-input").val() ?? "";
    state.has_zulip_call = $form.find<HTMLInputElement>(".calendar-form-call-checkbox").prop(
        "checked",
    ) as boolean;
    state.required_attendee_ids = get_attendee_ids(required_pills);
    state.optional_attendee_ids = get_attendee_ids(optional_pills);
}

function is_dirty(): boolean {
    if (state === undefined) {
        return false;
    }
    read_fields();
    return JSON.stringify(state) !== initial_state;
}

function update_time_fields(): void {
    assert(state !== undefined);
    const form = state;
    const $form = $("#calendar-view .calendar-form");
    $form
        .find(".calendar-form-time-summary")
        .text(get_time_summary(form))
        .attr("aria-expanded", String(is_time_expanded))
        .toggleClass("expanded", is_time_expanded);
    $form.find(".calendar-form-time-panel").toggleClass("hide", !is_time_expanded);
    $form
        .find(".calendar-form-date")
        .text(get_date_label(form.date))
        .attr(
            "aria-label",
            editing?.is_occurrence
                ? $t({defaultMessage: "Date: {date}"}, {date: get_date_label(form.date)})
                : $t({defaultMessage: "Start date: {date}"}, {date: get_date_label(form.date)}),
        );
    const start_options = Array.from(
        {length: MINUTES_PER_DAY / TIME_STEP_MINUTES},
        (_, index) => index * TIME_STEP_MINUTES,
    );
    if (!start_options.includes(form.start_minute)) {
        start_options.push(form.start_minute);
        start_options.sort((a, b) => a - b);
    }
    const $start = $form.find<HTMLSelectElement>(".calendar-form-start");
    $start.empty();
    for (const minute of start_options) {
        $start.append(
            $("<option>")
                .val(minute)
                .text(format_minutes(minute))
                .prop("selected", minute === form.start_minute),
        );
    }
    // The end is a duration from the start, of up to a day.
    const durations = Array.from(
        {length: MINUTES_PER_DAY / TIME_STEP_MINUTES},
        (_, index) => (index + 1) * TIME_STEP_MINUTES,
    );
    if (!durations.includes(form.duration_minutes)) {
        durations.push(form.duration_minutes);
        durations.sort((a, b) => a - b);
    }
    const $end = $form.find<HTMLSelectElement>(".calendar-form-end");
    $end.empty();
    for (const duration of durations) {
        const end = form.start_minute + duration;
        const label =
            end > MINUTES_PER_DAY ||
            (end === MINUTES_PER_DAY && form.start_minute > 0 && duration > MINUTES_PER_DAY / 2)
                ? $t({defaultMessage: "{time} (next day)"}, {time: format_minutes(end)})
                : format_minutes(end);
        $end.append(
            $("<option>")
                .val(duration)
                .text(label)
                .prop("selected", duration === form.duration_minutes),
        );
    }
    $form.find(".calendar-form-time-of-day").toggleClass("hide", form.is_all_day);
    $form.find(".calendar-form-all-day-checkbox").prop("checked", form.is_all_day);
    $form.find(".calendar-form-timezone-name").text(form.time_zone);
    $form
        .find(".calendar-form-timezone")
        .attr("aria-label", $t({defaultMessage: "Time zone: {time_zone}"}, {time_zone: form.time_zone}));
    update_recurrence_fields();
    update_suggestions();
    render_day();
    // The event stays in view on the day grid when its time changes.
    $form.find(".calendar-form-day-block").get(0)?.scrollIntoView({block: "nearest"});
}

function get_time_summary(form: FormState): string {
    const time_range = form.is_all_day
        ? undefined
        : {
              start: format_minutes(form.start_minute),
              end: format_minutes(form.start_minute + form.duration_minutes),
          };
    let summary;
    if (form.recurrence !== undefined) {
        summary = calendar_recurrence.describe(form.recurrence, form.date, time_range);
    } else if (time_range === undefined) {
        summary = $t({defaultMessage: "{date}, all day"}, {date: get_date_label(form.date)});
    } else {
        summary = `${get_date_label(form.date)} ${time_range.start} – ${time_range.end}`;
    }
    if (form.time_zone !== calendar_grid.get_time_zone()) {
        summary += ` (${form.time_zone})`;
    }
    return summary;
}

function get_frequency_label(frequency: calendar_recurrence.Frequency, count: number): string {
    switch (frequency) {
        case "DAILY":
            return $t({defaultMessage: "{count, plural, one {day} other {days}}"}, {count});
        case "WEEKLY":
            return $t({defaultMessage: "{count, plural, one {week} other {weeks}}"}, {count});
        case "MONTHLY":
            return $t({defaultMessage: "{count, plural, one {month} other {months}}"}, {count});
        case "YEARLY":
            return $t({defaultMessage: "{count, plural, one {year} other {years}}"}, {count});
    }
}

function update_recurrence_fields(): void {
    assert(state !== undefined);
    const recurrence = state.recurrence;
    const $form = $("#calendar-view .calendar-form");
    const is_recurring = recurrence !== undefined;
    $form
        .find(".calendar-form-repeats, .calendar-form-series-button")
        .attr("aria-pressed", String(is_recurring))
        .toggleClass("selected", is_recurring);
    $form
        .find(".calendar-form-event-button")
        .attr("aria-pressed", String(!is_recurring))
        .toggleClass("selected", !is_recurring);
    $form.find(".calendar-form-recurrence").toggleClass("hide", !is_recurring);
    if (recurrence === undefined) {
        return;
    }
    const $interval = $form.find(".calendar-form-interval").empty();
    for (let count = 1; count <= calendar_recurrence.MAX_INTERVAL; count += 1) {
        $interval.append(
            $("<option>")
                .val(count)
                .text(count)
                .prop("selected", count === recurrence.interval),
        );
    }
    const $frequency = $form.find(".calendar-form-frequency").empty();
    for (const frequency of calendar_recurrence.FREQUENCIES) {
        $frequency.append(
            $("<option>")
                .val(frequency)
                .text(get_frequency_label(frequency, recurrence.interval))
                .prop("selected", frequency === recurrence.frequency),
        );
    }
    const $weekdays = $form
        .find(".calendar-form-weekdays")
        .toggleClass("hide", recurrence.frequency !== "WEEKLY")
        .empty();
    for (const weekday of calendar_recurrence.WEEKDAYS) {
        const is_pressed = recurrence.weekdays.includes(weekday);
        $weekdays.append(
            $("<button>")
                .attr({
                    type: "button",
                    "data-weekday": weekday,
                    "aria-pressed": String(is_pressed),
                    "aria-label": calendar_recurrence.get_weekday_name(weekday, "long"),
                })
                .addClass("calendar-form-weekday")
                .toggleClass("selected", is_pressed)
                .text(
                    calendar_util.capitalize(
                        calendar_recurrence.get_weekday_name(weekday, "short"),
                        user_settings.default_language,
                    ),
                ),
        );
    }
    const until_label =
        recurrence.until === undefined
            ? $t({defaultMessage: "No end date"})
            : new Intl.DateTimeFormat(user_settings.default_language, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
              }).format(calendar_util.parse_date(recurrence.until)!);
    $form
        .find(".calendar-form-until")
        .text(until_label)
        .attr("aria-label", $t({defaultMessage: "Until: {date}"}, {date: until_label}));
    $form.find(".calendar-form-until-remove").toggleClass("hide", recurrence.until === undefined);
}

// Shows, for a meeting, the times of the same length in the user's
// work hours when the most attendees are free, at all of a series'
// first occurrences.
function update_suggestions(): void {
    assert(state !== undefined);
    const form = state;
    const $suggestions = $("#calendar-view .calendar-form-suggestions");
    const attendee_ids = [...form.required_attendee_ids, ...form.optional_attendee_ids];
    const dates =
        form.recurrence === undefined
            ? [form.date]
            : calendar_recurrence.get_occurrence_dates(
                  form.recurrence,
                  form.date,
                  MAX_CHECKED_OCCURRENCES,
                  MAX_CHECKED_DAYS,
              );
    if (!is_time_expanded || form.is_all_day || attendee_ids.length === 0 || dates.length === 0) {
        $suggestions.addClass("hide");
        return;
    }
    const user_ids = [current_user.user_id, ...attendee_ids];
    suggestions_request_id += 1;
    const request_id = suggestions_request_id;
    void channel.get({
        url: "/json/calendar/free_busy",
        data: {
            user_ids: JSON.stringify(user_ids),
            start: calendar_layout.get_day_start(dates[0]!, form.time_zone),
            // An event may end on the next day.
            end: calendar_layout.get_day_start(dates.at(-1)!, form.time_zone, 2),
        },
        success(raw_data) {
            if (request_id !== suggestions_request_id || state !== form) {
                return;
            }
            const {free_busy} = calendar_grid.free_busy_schema.parse(raw_data);
            render_suggestions(form, dates, user_ids, free_busy);
        },
    });
}

function render_suggestions(
    form: FormState,
    dates: string[],
    user_ids: number[],
    free_busy: Record<
        string,
        {start: number; end: number; show_as: number; event_id: number | null}[]
    >,
): void {
    const is_free = (user_id: number, minute: number): boolean =>
        dates.every((date) => {
            const start = get_start_seconds({...form, date, start_minute: minute});
            const end = start + form.duration_minutes * 60;
            return (free_busy[String(user_id)] ?? []).every(
                (block) =>
                    FREE_SHOW_AS.has(block.show_as) ||
                    block.end <= start ||
                    block.start >= end ||
                    (editing !== undefined && block.event_id === editing.occurrence.id),
            );
        });
    // ponytail: the user's work hours are taken in the event's
    // timezone, which is the user's own for most events; convert them
    // if meetings across timezones need it.
    const work_hours = calendar_grid.get_work_hours();
    const candidates = [];
    for (
        let minute = work_hours.start;
        minute + form.duration_minutes <= work_hours.end;
        minute += TIME_STEP_MINUTES
    ) {
        const free_count = user_ids.filter((user_id) => is_free(user_id, minute)).length;
        candidates.push({minute, free_ratio: free_count / user_ids.length});
    }
    // The freest times, then those nearest the chosen one, in the
    // order of the day.
    const chosen = candidates
        .sort(
            (a, b) =>
                b.free_ratio - a.free_ratio ||
                Math.abs(a.minute - form.start_minute) - Math.abs(b.minute - form.start_minute),
        )
        .slice(0, MAX_SUGGESTIONS)
        .sort((a, b) => a.minute - b.minute);
    const percent = new Intl.NumberFormat(user_settings.default_language, {style: "percent"});
    const minutes = new Intl.NumberFormat(user_settings.default_language, {
        style: "unit",
        unit: "minute",
        unitDisplay: "short",
    });
    const $suggestions = $("#calendar-view .calendar-form-suggestions");
    $suggestions.toggleClass("hide", chosen.length === 0);
    $suggestions.find(".calendar-form-suggestion-list").html(
        render_calendar_form_suggestions({
            is_recurring: form.recurrence !== undefined,
            day_label:
                form.recurrence === undefined
                    ? get_date_label(form.date)
                    : calendar_util.capitalize(
                          calendar_recurrence.describe_pattern(form.recurrence, dates[0]!),
                          user_settings.default_language,
                      ),
            suggestions: chosen.map(({minute, free_ratio}) => ({
                minute,
                is_selected: minute === form.start_minute,
                time_label: `${format_minutes(minute)} – ${format_minutes(minute + form.duration_minutes)} (${minutes.format(form.duration_minutes)})`,
                is_everyone_free: free_ratio === 1,
                free_label: $t(
                    {defaultMessage: "{percent} free"},
                    {percent: percent.format(free_ratio)},
                ),
            })),
        }),
    );
}

function update_menu_buttons(): void {
    assert(state !== undefined);
    const $form = $("#calendar-view .calendar-form");
    const status = calendar_grid.get_free_busy_status(state.show_as);
    const $show_as = $form.find('.calendar-form-menu-button[data-menu="show_as"]');
    $show_as.find(".calendar-form-menu-label").text(status.label);
    $show_as
        .find(".calendar-form-show-as-swatch")
        .attr("class", `calendar-event free-busy calendar-legend-swatch calendar-form-show-as-swatch ${status.class_name}`);
    $show_as.attr("aria-label", $t({defaultMessage: "Show as: {status}"}, {status: status.label}));
    $form
        .find('.calendar-form-menu-button[data-menu="reminder"]')
        .attr(
            "aria-label",
            $t({defaultMessage: "Reminder: {reminder}"}, {reminder: get_reminder_label(state.reminder_minutes)}),
        );
    const category = CATEGORIES.find(([name]) => name === state!.category);
    $form
        .find('.calendar-form-menu-button[data-menu="category"]')
        .attr(
            "aria-label",
            $t(
                {defaultMessage: "Category: {category}"},
                {category: get_category_label(category?.[1] ?? "none")},
            ),
        )
        .find(".calendar-form-category-swatch")
        .attr("class", `calendar-form-category-swatch ${category?.[1] ?? ""}`);
    $form
        .find('.calendar-form-menu-button[data-menu="visibility"]')
        .attr(
            "aria-label",
            $t({defaultMessage: "Visibility: {visibility}"}, {visibility: get_visibility_label(state.is_private)}),
        )
        .toggleClass("selected", state.is_private);
}

function render_day(): void {
    assert(state !== undefined);
    const form = state;
    const percent = (minutes: number): number => (minutes / MINUTES_PER_DAY) * 100;
    const $grid = $("#calendar-view .calendar-form-day-grid");
    $grid.html(
        render_calendar_form_day({
            hours: Array.from({length: 23}, (_, index) => ({
                label: user_settings.twenty_four_hour_time
                    ? String(index + 1)
                    : new Intl.DateTimeFormat(user_settings.default_language, {
                          hour: "numeric",
                          hourCycle: "h12",
                      }).format(new Date(2000, 0, 1, index + 1)),
                top: percent((index + 1) * 60),
            })),
            is_all_day: form.is_all_day,
            top: percent(form.start_minute),
            height: percent(
                Math.min(form.duration_minutes, MINUTES_PER_DAY - form.start_minute),
            ),
            time_label: `${format_minutes(form.start_minute)} – ${format_minutes(form.start_minute + form.duration_minutes)}`,
        }),
    );
    $("#calendar-view .calendar-form-day-label").text(get_long_date_label(form.date));
    fetch_day_events();
}

// The user's other events on the form's day, to see what the event
// would overlap.
function fetch_day_events(): void {
    assert(state !== undefined);
    const date = state.date;
    const time_zone = state.time_zone;
    day_request_id += 1;
    const request_id = day_request_id;
    void channel.get({
        url: "/json/calendar/events",
        data: {
            start: calendar_layout.get_day_start(date, time_zone),
            end: calendar_layout.get_day_start(date, time_zone, 1),
        },
        success(raw_data) {
            if (request_id !== day_request_id || state === undefined) {
                return;
            }
            const events = day_events_schema
                .parse(raw_data)
                .events.filter(
                    (event) => editing === undefined || event.id !== editing.occurrence.id,
                );
            const layout = calendar_layout.get_week_layout(events, [date], time_zone, 15);
            $("#calendar-view .calendar-form-day-column .calendar-day-events").html(
                render_calendar_day_events({
                    events: (layout.days[0] ?? []).map((placement) => ({
                        title: placement.event.title,
                        class_names: "meeting calendar-form-day-other",
                        top: (placement.start_minute / MINUTES_PER_DAY) * 100,
                        height:
                            (Math.max(placement.end_minute - placement.start_minute, 15) /
                                MINUTES_PER_DAY) *
                            100,
                        left: (placement.column / placement.column_count) * 100,
                        width: 100 / placement.column_count,
                        label: placement.event.title,
                    })),
                }),
            );
        },
    });
}

function scroll_day_to_event(): void {
    assert(state !== undefined);
    const $scroll = $("#calendar-view .calendar-form-day-scroll");
    const column = $scroll.find(".calendar-form-day-column").get(0);
    if (column === undefined) {
        return;
    }
    const minute = Math.max(state.start_minute - 60, 0);
    $scroll.scrollTop((minute / MINUTES_PER_DAY) * column.getBoundingClientRect().height);
}

// Moves the event, or resizes it from its bottom edge, as the pointer
// moves on the day grid.
function start_drag(e: JQuery.TriggeredEvent, is_resize: boolean): void {
    assert(state !== undefined);
    const form = state;
    const pointer = e.originalEvent as PointerEvent;
    const block = (e.currentTarget as HTMLElement).closest<HTMLElement>(".calendar-form-day-block")!;
    const column = block.closest<HTMLElement>(".calendar-form-day-column")!;
    const start_y = pointer.clientY;
    const start_minute = form.start_minute;
    const start_duration = form.duration_minutes;
    block.setPointerCapture(pointer.pointerId);
    const on_move = (move: PointerEvent): void => {
        const delta = calendar_util.snap_minutes(
            ((move.clientY - start_y) / column.getBoundingClientRect().height) * MINUTES_PER_DAY,
            DRAG_STEP_MINUTES,
        );
        if (is_resize) {
            form.duration_minutes = Math.max(
                start_duration + delta,
                DRAG_STEP_MINUTES,
            );
        } else {
            form.start_minute = Math.min(
                Math.max(start_minute + delta, 0),
                MINUTES_PER_DAY - DRAG_STEP_MINUTES,
            );
        }
        const percent = (minutes: number): number => (minutes / MINUTES_PER_DAY) * 100;
        block.style.top = `${percent(form.start_minute)}%`;
        block.style.height = `${percent(Math.min(form.duration_minutes, MINUTES_PER_DAY - form.start_minute))}%`;
        const label = `${format_minutes(form.start_minute)} – ${format_minutes(form.start_minute + form.duration_minutes)}`;
        $(block).find(".calendar-form-day-block-time").text(label);
        block.setAttribute("aria-valuetext", label);
    };
    const on_up = (): void => {
        block.removeEventListener("pointermove", on_move);
        block.removeEventListener("pointerup", on_up);
        block.removeEventListener("pointercancel", on_up);
        update_time_fields();
    };
    block.addEventListener("pointermove", on_move);
    block.addEventListener("pointerup", on_up);
    block.addEventListener("pointercancel", on_up);
}

function move_by_keyboard(key: string, is_resize: boolean): boolean {
    assert(state !== undefined);
    let delta = 0;
    if (key === "ArrowUp") {
        delta = -DRAG_STEP_MINUTES;
    } else if (key === "ArrowDown") {
        delta = DRAG_STEP_MINUTES;
    } else {
        return false;
    }
    if (is_resize) {
        state.duration_minutes = Math.max(state.duration_minutes + delta, DRAG_STEP_MINUTES);
    } else {
        state.start_minute = Math.min(
            Math.max(state.start_minute + delta, 0),
            MINUTES_PER_DAY - DRAG_STEP_MINUTES,
        );
    }
    update_time_fields();
    $("#calendar-view .calendar-form-day-block").trigger("focus");
    return true;
}

function hide_menu(): void {
    popover_menus.hide_current_popover_if_visible(menu_instance ?? null);
    menu_instance = undefined;
}

export function show_choice_menu(
    button: HTMLElement,
    options: {value: string; label: string; checked: boolean}[],
    on_choose: (value: string) => void,
): void {
    popover_menus.toggle_popover_menu(button, {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            menu_instance = instance;
            instance.setContent(
                ui_util.parse_html(
                    render_calendar_submenu_popover({
                        id: "form",
                        is_radio: true,
                        options: options.map((option) => ({
                            ...option,
                            checked: String(option.checked),
                        })),
                    }),
                ),
            );
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            $(instance.popper).on("click", ".calendar-submenu-option", function (this: HTMLElement, e) {
                e.preventDefault();
                on_choose(this.dataset["value"]!);
                popover_menus.hide_current_popover_if_visible(instance);
            });
        },
        onHidden(instance) {
            instance.destroy();
            if (menu_instance === instance) {
                menu_instance = undefined;
            }
        },
    });
}

function show_menu(button: HTMLElement): void {
    assert(state !== undefined);
    const form = state;
    const choose = (value: string): void => {
        switch (button.dataset["menu"]) {
            case "show_as":
                form.show_as = Number(value);
                break;
            case "reminder":
                form.reminder_minutes = value === "" ? null : Number(value);
                break;
            case "category":
                form.category = value;
                break;
            default:
                form.is_private = value === "private";
        }
        update_menu_buttons();
    };
    const menu = button.dataset["menu"];
    const options =
        menu === "show_as" || menu === "reminder" || menu === "category"
            ? get_personal_menu_options(menu, form)
            : [
                  {value: "private", label: get_visibility_label(true), checked: form.is_private},
                  {
                      value: "public",
                      label: get_visibility_label(false),
                      checked: !form.is_private,
                  },
              ];
    show_choice_menu(button, options, choose);
}

// The choices of how an event shows the user, their reminder and its
// category, which the meeting opened on the whole window offers too.
export function get_personal_menu_options(
    menu: "show_as" | "reminder" | "category",
    values: {show_as: number; reminder_minutes: number | null; category: string},
): {value: string; label: string; checked: boolean}[] {
    switch (menu) {
        case "show_as":
            return [1, 5, 2, 3, 4].map((show_as) => ({
                value: String(show_as),
                label: get_show_as_label(show_as),
                checked: show_as === values.show_as,
            }));
        case "reminder":
            return REMINDERS.map((minutes) => ({
                value: minutes === null ? "" : String(minutes),
                label: get_reminder_label(minutes),
                checked: minutes === values.reminder_minutes,
            }));
        case "category":
            return [
                {value: "", label: get_category_label("none"), checked: values.category === ""},
                ...CATEGORIES.map(([name, color]) => ({
                    value: name,
                    label: get_category_label(color),
                    checked: name === values.category,
                })),
            ];
    }
}

// The color of a category, by the name Exchange stores, or "" for none.
export function get_category_color(category: string): string {
    return CATEGORIES.find(([name]) => name === category)?.[1] ?? "";
}

function show_attendee_options(button: HTMLElement): void {
    assert(state !== undefined);
    const form = state;
    popover_menus.toggle_popover_menu(button, {
        theme: "popover-menu",
        placement: "bottom-end",
        onShow(instance) {
            menu_instance = instance;
            instance.setContent(
                ui_util.parse_html(
                    render_calendar_form_attendee_options_popover({
                        options: [
                            {
                                name: "response_requested",
                                label: $t({defaultMessage: "Request responses"}),
                                checked: form.response_requested,
                            },
                            {
                                name: "allow_forwarding",
                                label: $t({defaultMessage: "Allow forwarding"}),
                                checked: form.allow_forwarding,
                            },
                            {
                                name: "hide_attendees",
                                label: $t({defaultMessage: "Hide the attendee list"}),
                                checked: form.hide_attendees,
                            },
                        ],
                    }),
                ),
            );
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            $popper.on("click", ".calendar-form-attendee-option", function (this: HTMLElement, e) {
                e.preventDefault();
                const name = this.dataset["option"];
                assert(
                    name === "response_requested" ||
                        name === "allow_forwarding" ||
                        name === "hide_attendees",
                );
                form[name] = !form[name];
                $(this).attr("aria-checked", String(form[name]));
                $(this).find("input").prop("checked", form[name]);
            });
            $popper.on("click", ".calendar-form-add-optional", (e) => {
                e.preventDefault();
                popover_menus.hide_current_popover_if_visible(instance);
                $("#calendar-view .calendar-form-optional-row").removeClass("hide");
                $("#calendar-view .calendar-form-optional-attendees .input").trigger("focus");
            });
        },
        onHidden(instance) {
            instance.destroy();
            if (menu_instance === instance) {
                menu_instance = undefined;
            }
        },
    });
}

function show_date_picker(
    button: HTMLElement,
    date: string,
    on_pick: (date: string) => void,
): void {
    assert(get_mini_month_context !== undefined);
    const get_context = get_mini_month_context;
    const render = (instance: tippy.Instance, month: Date): void => {
        instance.setContent(
            ui_util.parse_html(render_calendar_date_picker_popover(get_context(month))),
        );
    };
    popover_menus.toggle_popover_menu(button, {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            menu_instance = instance;
            render(instance, calendar_util.parse_date(date)!);
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            const get_month = (element: HTMLElement): Date =>
                calendar_util.parse_date(
                    $(element).closest(".calendar-mini-month").attr("data-month")!,
                )!;
            $popper.on("click", ".calendar-mini-month-previous", function (this: HTMLElement) {
                render(instance, addMonths(get_month(this), -1));
            });
            $popper.on("click", ".calendar-mini-month-next", function (this: HTMLElement) {
                render(instance, addMonths(get_month(this), 1));
            });
            $popper.on("click", ".calendar-mini-month-day", function (this: HTMLElement) {
                popover_menus.hide_current_popover_if_visible(instance);
                on_pick(this.dataset["date"]!);
            });
        },
        onHidden(instance) {
            instance.destroy();
            if (menu_instance === instance) {
                menu_instance = undefined;
            }
        },
    });
}

function move_day(days: number): void {
    assert(state !== undefined);
    state.date = calendar_util.format_date(addDays(calendar_util.parse_date(state.date)!, days));
    update_time_fields();
}

function toggle_preview(): void {
    const $form = $("#calendar-view .calendar-form");
    const $button = $form.find(".calendar-form-preview");
    const is_previewing = $button.attr("aria-pressed") !== "true";
    $button.attr("aria-pressed", String(is_previewing)).toggleClass("selected", is_previewing);
    $form.find(".calendar-form-editor").toggleClass("previewing", is_previewing);
    if (!is_previewing) {
        $form.find(".calendar-form-description-input").trigger("focus");
        return;
    }
    const content = $form.find<HTMLTextAreaElement>(".calendar-form-description-input").val() ?? "";
    const $preview = $form.find(".calendar-form-description-preview");
    if (content.trim() === "") {
        $preview.text($t({defaultMessage: "Nothing to preview"}));
        return;
    }
    void channel.post({
        url: "/json/messages/render",
        data: {content},
        success(raw_data) {
            const {rendered} = z.object({rendered: z.string()}).parse(raw_data);
            $preview.html(rendered);
            rendered_markdown.update_elements($preview);
        },
    });
}

function show_error(message: string): void {
    $("#calendar-view .calendar-form-error").text(message).addClass("shown");
}

function validate(): boolean {
    assert(state !== undefined);
    const $title_error = $("#calendar-view .calendar-form-title-error");
    if (state.title.trim() === "") {
        $title_error.text($t({defaultMessage: "Add a title."})).addClass("shown");
        $("#calendar-view .calendar-form-title").trigger("focus");
        return false;
    }
    $title_error.removeClass("shown");
    return true;
}

function get_event_data(form: FormState): Record<string, string> {
    const time = {
        ...form,
        date:
            form.recurrence === undefined
                ? form.date
                : calendar_recurrence.get_first_date(form.recurrence, form.date),
    };
    return {
        title: form.title.trim(),
        start: JSON.stringify(get_start_seconds(time)),
        end: JSON.stringify(get_end_seconds(time)),
        timezone: form.time_zone,
        is_all_day: JSON.stringify(form.is_all_day),
        rrule:
            form.recurrence === undefined
                ? ""
                : calendar_recurrence.format_rrule(form.recurrence, form.time_zone),
        description: form.description,
        location: form.location,
        show_as: JSON.stringify(form.show_as),
        is_private: JSON.stringify(form.is_private),
        response_requested: JSON.stringify(form.response_requested),
        allow_forwarding: JSON.stringify(form.allow_forwarding),
        hide_attendees: JSON.stringify(form.hide_attendees),
        has_zulip_call: JSON.stringify(form.has_zulip_call),
        required_attendees: JSON.stringify(form.required_attendee_ids),
        optional_attendees: JSON.stringify(form.optional_attendee_ids),
    };
}

// The fields that changed since the form opened, which is what a
// change sends.
function get_changed_data(form: FormState): Record<string, string> {
    assert(initial_state !== undefined && editing !== undefined);
    const initial = JSON.parse(initial_state) as FormState;
    const data = get_event_data(form);
    const initial_data = get_event_data(initial);
    const changed = Object.fromEntries(
        Object.entries(data).filter(([key, value]) => value !== initial_data[key]),
    );
    // The time is sent whole, with the timezone it is in.
    if (
        "start" in changed ||
        "end" in changed ||
        "timezone" in changed ||
        "is_all_day" in changed
    ) {
        changed["start"] = data["start"]!;
        changed["end"] = data["end"]!;
        changed["timezone"] = data["timezone"]!;
    }
    if (editing.is_occurrence) {
        // An occurrence keeps the settings of its series.
        const occurrence_fields = ["title", "description", "location", "start", "end"];
        return {
            ...Object.fromEntries(
                Object.entries(changed).filter(([key]) => occurrence_fields.includes(key)),
            ),
            occurrence: JSON.stringify(editing.occurrence.original_start),
        };
    }
    return changed;
}

function save_personal_settings(event_id: number, form: FormState, on_done: () => void): void {
    const initial = initial_state === undefined ? undefined : (JSON.parse(initial_state) as FormState);
    const data: Record<string, string> = {};
    if (initial?.reminder_minutes !== form.reminder_minutes) {
        data["reminder_minutes"] = JSON.stringify(form.reminder_minutes);
    }
    if (initial?.category !== form.category) {
        data["category"] = form.category;
    }
    if (Object.keys(data).length === 0) {
        on_done();
        return;
    }
    void channel.patch({
        url: `/json/calendar/events/${event_id}/personal_settings`,
        data,
        success: on_done,
        error(xhr) {
            show_error(channel.xhr_error_message($t({defaultMessage: "Failed to save the event"}), xhr));
            is_saving = false;
        },
    });
}

function save(): void {
    if (state === undefined || is_saving) {
        return;
    }
    read_fields();
    if (!validate()) {
        return;
    }
    const time_fields = ["start", "end", "timezone", "is_all_day", "rrule"];
    if (
        editing !== undefined &&
        !editing.is_occurrence &&
        has_changed_occurrences &&
        Object.keys(get_changed_data(state)).some((key) => time_fields.includes(key))
    ) {
        confirm_dialog.launch({
            modal_title_html: $t_html({defaultMessage: "Change the whole series?"}),
            modal_content_html: $("<p>")
                .text(
                    $t({
                        defaultMessage:
                            "Some occurrences of this series were changed or canceled on their own. Changing when the series takes place undoes those changes.",
                    }),
                )
                .prop("outerHTML") as string,
            is_compact: true,
            modal_submit_button_text: $t({defaultMessage: "Change the series"}),
            on_click: send,
        });
        return;
    }
    send();
}

function send(): void {
    assert(state !== undefined);
    const form = state;
    is_saving = true;
    $("#calendar-view .calendar-form-save").prop("disabled", true);
    const on_error = (xhr: JQuery.jqXHR): void => {
        is_saving = false;
        $("#calendar-view .calendar-form-save").prop("disabled", false);
        show_error(channel.xhr_error_message($t({defaultMessage: "Failed to save the event"}), xhr));
    };
    const on_saved = (): void => {
        is_saving = false;
        close();
        calendar_grid.refresh();
    };
    if (editing === undefined) {
        void channel.post({
            url: "/json/calendar/events",
            data: get_event_data(form),
            success(raw_data) {
                const {id} = z.object({id: z.number()}).parse(raw_data);
                save_personal_settings(id, form, on_saved);
            },
            error: on_error,
        });
        return;
    }
    const event_id = editing.occurrence.id;
    const data = get_changed_data(form);
    const after_event = (): void => {
        save_personal_settings(event_id, form, on_saved);
    };
    if (Object.keys(data).every((key) => key === "occurrence")) {
        after_event();
        return;
    }
    void channel.patch({
        url: `/json/calendar/events/${event_id}`,
        data,
        success: after_event,
        error: on_error,
    });
}

export function close(): void {
    hide_menu();
    state = undefined;
    initial_state = undefined;
    editing = undefined;
    is_saving = false;
    required_pills = undefined;
    optional_pills = undefined;
    $("#calendar-view").removeClass("editing-event");
    $("#calendar-view .calendar-form-container").empty();
    on_close?.();
}

// Asks before losing changes.
export function cancel(): void {
    if (!is_dirty()) {
        close();
        return;
    }
    confirm_dialog.launch({
        modal_title_html: $t_html({defaultMessage: "Discard your changes?"}),
        modal_content_html: $("<p>")
            .text($t({defaultMessage: "The event will not be saved."}))
            .prop("outerHTML") as string,
        is_compact: true,
        modal_submit_button_text: $t({defaultMessage: "Discard"}),
        on_click: close,
    });
}

function create_pills(selector: string, user_ids: number[], is_disabled: boolean): InputPillContainer<UserPill> {
    const $container = $(`#calendar-view ${selector}`);
    const pills = user_pill.create_pills($container, {exclude_inaccessible_users: true});
    for (const user_id of user_ids) {
        const user = people.maybe_get_user_by_id(user_id, true);
        if (user !== undefined) {
            user_pill.append_user(user, pills, false);
        }
    }
    if (!is_disabled) {
        pill_typeahead.set_up_user($container.find(".input"), pills, {
            exclude_bots: true,
            exclude_user_ids: [current_user.user_id],
        });
    }
    return pills;
}

function on_attendees_change(): void {
    read_fields();
    update_suggestions();
}

function set_up_timezone_widget(): void {
    const now = new Date();
    new dropdown_widget.DropdownWidget({
        widget_name: "calendar_form_timezone",
        widget_selector: "#calendar-view .calendar-form-timezone",
        get_options: () =>
            timezones.timezones.map((time_zone) => ({
                name: `${time_zone} (${timerender.get_utc_offset_string(time_zone, now)})`,
                unique_id: time_zone,
            })),
        item_click_callback(event, dropdown, widget) {
            dropdown.hide();
            event.preventDefault();
            event.stopPropagation();
            assert(state !== undefined);
            // The event keeps its time of day in the new timezone.
            state.time_zone = String(widget.value());
            update_time_fields();
        },
        $events_container: $("#calendar-view .calendar-form"),
        default_id: state?.time_zone,
        unique_id_type: "string",
        search_placeholder_text: $t({defaultMessage: "Time zone of the event"}),
    }).setup();
}

function render_form(): void {
    assert(state !== undefined);
    const form = state;
    const form_editing = editing;
    const is_occurrence = form_editing?.is_occurrence ?? false;
    $("#calendar-view").addClass("editing-event");
    $("#calendar-view .calendar-form-container").html(
        render_calendar_form({
            is_editing: form_editing !== undefined,
            is_occurrence,
            title: form.title,
            location: form.location,
            description: form.description,
            has_zulip_call: form.has_zulip_call,
            has_optional_attendees: form.optional_attendee_ids.length > 0,
            formatting_buttons: [
                {type: "bold", icon: "bold", label: $t({defaultMessage: "Bold"})},
                {type: "italic", icon: "italic", label: $t({defaultMessage: "Italic"})},
                {
                    type: "strikethrough",
                    icon: "strikethrough",
                    label: $t({defaultMessage: "Strikethrough"}),
                },
                {
                    type: "bulleted",
                    icon: "unordered-list",
                    label: $t({defaultMessage: "Bulleted list"}),
                },
                {
                    type: "numbered",
                    icon: "ordered-list",
                    label: $t({defaultMessage: "Numbered list"}),
                },
                {type: "quote", icon: "quote", label: $t({defaultMessage: "Quote"})},
                {type: "code", icon: "code", label: $t({defaultMessage: "Code"})},
                {type: "link", icon: "link", label: $t({defaultMessage: "Link"})},
            ],
        }),
    );
    required_pills = create_pills(
        ".calendar-form-required-attendees",
        form.required_attendee_ids,
        is_occurrence,
    );
    optional_pills = create_pills(
        ".calendar-form-optional-attendees",
        form.optional_attendee_ids,
        is_occurrence,
    );
    for (const pills of [required_pills, optional_pills]) {
        pills.onPillCreate(on_attendees_change);
        pills.onPillRemove(on_attendees_change);
    }
    set_up_timezone_widget();
    update_menu_buttons();
    update_time_fields();
    scroll_day_to_event();
    $("#calendar-view .calendar-form-title").trigger("focus");
}

function open(form: FormState, form_editing: Editing | undefined): void {
    state = form;
    editing = form_editing;
    is_time_expanded = false;
    render_form();
    read_fields();
    initial_state = JSON.stringify(state);
}

// Draws the form again when the calendar shows again, with the
// changes made before it was left.
export function restore(): void {
    if (state !== undefined) {
        render_form();
    }
}

// Keeps the changes when the user leaves the calendar.
export function save_draft(): void {
    if (state !== undefined) {
        read_fields();
        hide_menu();
    }
}

function get_default_reminder(): number | null {
    return calendar_grid.get_default_reminder();
}

// A new event, at a time or at the next half hour of today.
export function open_new(date: string, start_minute: number): void {
    open(
        {
            title: "",
            required_attendee_ids: [],
            optional_attendee_ids: [],
            date,
            start_minute,
            duration_minutes: TIME_STEP_MINUTES,
            time_zone: calendar_grid.get_time_zone(),
            is_all_day: false,
            recurrence: undefined,
            location: "",
            has_zulip_call: false,
            description: "",
            show_as: SHOW_AS_BUSY,
            reminder_minutes: get_default_reminder(),
            category: "",
            is_private: false,
            response_requested: true,
            allow_forwarding: true,
            hide_attendees: false,
        },
        undefined,
    );
}

export function open_now(): void {
    const now = new TZDate(Date.now(), calendar_grid.get_time_zone());
    const minute = now.getHours() * 60 + now.getMinutes();
    const next = Math.ceil(minute / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
    const date = format(now, "yyyy-MM-dd");
    if (next >= MINUTES_PER_DAY) {
        open_new(calendar_util.format_date(addDays(calendar_util.parse_date(date)!, 1)), 0);
    } else {
        open_new(date, next);
    }
}

function open_event(
    occurrence: CalendarOccurrence,
    is_occurrence: boolean,
    event_has_changed_occurrences: boolean,
): void {
    // The time is that of the event's timezone.
    const start = new TZDate(occurrence.start * 1000, occurrence.timezone);
    const attendees = occurrence.attendees.filter(
        (attendee) => attendee.user_id !== occurrence.organizer_id,
    );
    has_changed_occurrences = event_has_changed_occurrences;
    open(
        {
            title: occurrence.title,
            required_attendee_ids: attendees
                .filter((attendee) => attendee.is_required)
                .map((attendee) => attendee.user_id),
            optional_attendee_ids: attendees
                .filter((attendee) => !attendee.is_required)
                .map((attendee) => attendee.user_id),
            date: format(start, "yyyy-MM-dd"),
            start_minute: occurrence.is_all_day ? 0 : start.getHours() * 60 + start.getMinutes(),
            duration_minutes: occurrence.is_all_day
                ? MINUTES_PER_DAY
                : Math.round((occurrence.end - occurrence.start) / 60),
            time_zone: occurrence.timezone,
            is_all_day: occurrence.is_all_day,
            // An occurrence is changed on its own date.
            recurrence: is_occurrence
                ? undefined
                : calendar_recurrence.parse_rrule(occurrence.rrule, occurrence.timezone),
            location: occurrence.location,
            has_zulip_call: occurrence.has_zulip_call,
            description: occurrence.description,
            show_as: occurrence.show_as,
            reminder_minutes: occurrence.reminder_minutes,
            category: occurrence.category,
            is_private: occurrence.is_private,
            response_requested: occurrence.response_requested,
            allow_forwarding: occurrence.allow_forwarding,
            hide_attendees: occurrence.hide_attendees,
        },
        {occurrence, is_occurrence},
    );
}

export function open_edit(occurrence: CalendarOccurrence, is_occurrence: boolean): void {
    if (is_occurrence || occurrence.original_start === null) {
        open_event(occurrence, is_occurrence, false);
        return;
    }
    // A series is changed from its start, with its own fields rather
    // than those of a changed occurrence.
    void channel.get({
        url: `/json/calendar/events/${occurrence.id}`,
        success(raw_data) {
            const data = z
                .object({
                    event: calendar_grid.occurrence_schema,
                    has_changed_occurrences: z.boolean(),
                })
                .parse(raw_data);
            open_event(data.event, false, data.has_changed_occurrences);
        },
        error(xhr) {
            ui_report.error(
                $t_html({defaultMessage: "Failed to open the event"}),
                xhr,
                $("#home-error"),
            );
        },
    });
}

export function initialize(opts: {
    on_close: () => void;
    get_mini_month_context: (month: Date) => Record<string, unknown>;
}): void {
    on_close = opts.on_close;
    get_mini_month_context = opts.get_mini_month_context;
    const $view = $("#calendar-view");
    $view.on("submit", ".calendar-form", (e) => {
        e.preventDefault();
        save();
    });
    $view.on("click", ".calendar-form-cancel", () => {
        cancel();
    });
    $view.on("keydown", ".calendar-form", (e) => {
        if (e.key === "Escape" && !popovers.any_active()) {
            e.preventDefault();
            cancel();
        }
    });
    $view.on("click", ".calendar-form-menu-button", function (this: HTMLElement) {
        show_menu(this);
    });
    // The menu belongs to a wrapper of the button, since an element
    // with a tooltip cannot also open a popover.
    $view.on("click", ".calendar-form-attendee-options-trigger", function (this: HTMLElement) {
        show_attendee_options(this);
    });
    $view.on("click", ".calendar-form-date", function (this: HTMLElement) {
        assert(state !== undefined);
        const form = state;
        show_date_picker(this, form.date, (date) => {
            const recurrence = form.recurrence;
            // A weekly series on the start's weekday moves with it.
            if (
                recurrence?.frequency === "WEEKLY" &&
                recurrence.weekdays.length === 1 &&
                recurrence.weekdays[0] === calendar_recurrence.get_weekday(form.date)
            ) {
                recurrence.weekdays = [calendar_recurrence.get_weekday(date)];
            }
            form.date = date;
            update_time_fields();
        });
    });
    $view.on("click", ".calendar-form-until", function (this: HTMLElement) {
        assert(state?.recurrence !== undefined);
        const recurrence = state.recurrence;
        show_date_picker(this, recurrence.until ?? state.date, (date) => {
            recurrence.until = date;
            update_time_fields();
        });
    });
    $view.on("click", ".calendar-form-until-remove", () => {
        assert(state?.recurrence !== undefined);
        state.recurrence.until = undefined;
        update_time_fields();
        $("#calendar-view .calendar-form-until").trigger("focus");
    });
    $view.on("click", ".calendar-form-time-summary", () => {
        is_time_expanded = !is_time_expanded;
        update_time_fields();
    });
    $view.on("click", ".calendar-form-event-button", () => {
        assert(state !== undefined);
        state.recurrence = undefined;
        update_time_fields();
    });
    $view.on("click", ".calendar-form-series-button", () => {
        assert(state !== undefined);
        state.recurrence ??= calendar_recurrence.get_default_recurrence(state.date);
        is_time_expanded = true;
        update_time_fields();
    });
    $view.on("click", ".calendar-form-repeats", () => {
        assert(state !== undefined);
        state.recurrence =
            state.recurrence === undefined
                ? calendar_recurrence.get_default_recurrence(state.date)
                : undefined;
        update_time_fields();
    });
    $view.on("change", ".calendar-form-interval", function (this: HTMLSelectElement) {
        assert(state?.recurrence !== undefined);
        state.recurrence.interval = Number(this.value);
        update_time_fields();
    });
    $view.on("change", ".calendar-form-frequency", function (this: HTMLSelectElement) {
        assert(state?.recurrence !== undefined);
        const frequency = calendar_recurrence.FREQUENCIES.find((value) => value === this.value)!;
        state.recurrence.frequency = frequency;
        if (frequency === "WEEKLY" && state.recurrence.weekdays.length === 0) {
            state.recurrence.weekdays = [calendar_recurrence.get_weekday(state.date)];
        }
        update_time_fields();
    });
    $view.on("click", ".calendar-form-weekday", function (this: HTMLElement) {
        assert(state?.recurrence !== undefined);
        const recurrence = state.recurrence;
        const weekday = calendar_recurrence.WEEKDAYS.find(
            (value) => value === this.dataset["weekday"],
        )!;
        if (!recurrence.weekdays.includes(weekday)) {
            recurrence.weekdays = calendar_recurrence.WEEKDAYS.filter(
                (value) => value === weekday || recurrence.weekdays.includes(value),
            );
        } else if (recurrence.weekdays.length > 1) {
            // A weekly series repeats on at least one day.
            recurrence.weekdays = recurrence.weekdays.filter((value) => value !== weekday);
        }
        update_time_fields();
        $(`#calendar-view .calendar-form-weekday[data-weekday="${weekday}"]`).trigger("focus");
    });
    $view.on("click", ".calendar-form-suggestion", function (this: HTMLElement) {
        assert(state !== undefined);
        state.start_minute = Number(this.dataset["minute"]);
        update_time_fields();
    });
    $view.on("change", ".calendar-form-start", function (this: HTMLSelectElement) {
        assert(state !== undefined);
        // The end moves with the start.
        state.start_minute = Number(this.value);
        update_time_fields();
    });
    $view.on("change", ".calendar-form-end", function (this: HTMLSelectElement) {
        assert(state !== undefined);
        state.duration_minutes = Number(this.value);
        update_time_fields();
    });
    $view.on("change", ".calendar-form-all-day-checkbox", function (this: HTMLInputElement) {
        assert(state !== undefined);
        state.is_all_day = this.checked;
        update_time_fields();
    });
    $view.on("click", ".calendar-form-previous-day", () => {
        move_day(-1);
    });
    $view.on("click", ".calendar-form-next-day", () => {
        move_day(1);
    });
    $view.on("click", ".calendar-form-format", function (this: HTMLElement) {
        const $textarea = $view.find<HTMLTextAreaElement>(".calendar-form-description-input");
        compose_ui.format_text($textarea, this.dataset["formatType"]!);
        $textarea.trigger("focus");
    });
    $view.on("click", ".calendar-form-preview", () => {
        toggle_preview();
    });
    $view.on("pointerdown", ".calendar-form-day-block", (e) => {
        const is_resize = $(e.target).closest(".calendar-form-day-block-resize").length > 0;
        e.preventDefault();
        start_drag(e, is_resize);
    });
    $view.on("keydown", ".calendar-form-day-block", (e) => {
        if (move_by_keyboard(e.key, e.shiftKey)) {
            e.preventDefault();
        }
    });
}
