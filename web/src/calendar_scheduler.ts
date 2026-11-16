import {TZDate} from "@date-fns/tz";
import {addDays, getISODay} from "date-fns";
import {$} from "jquery";
import * as z from "zod/mini";

import render_calendar_scheduler from "../templates/calendar/calendar_scheduler.hbs";
import render_calendar_scheduler_options_popover from "../templates/popovers/calendar/calendar_scheduler_options_popover.hbs";

import * as calendar_form from "./calendar_form.ts";
import type {SchedulingState} from "./calendar_form.ts";
import * as calendar_grid from "./calendar_grid.ts";
import * as calendar_layout from "./calendar_layout.ts";
import * as calendar_rooms from "./calendar_rooms.ts";
import * as calendar_util from "./calendar_util.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import {localstorage} from "./localstorage.ts";
import * as people from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import * as popover_menus from "./popover_menus.ts";
import * as popovers from "./popovers.ts";
import {current_user} from "./state_data.ts";
import * as timerender from "./timerender.ts";
import * as ui_util from "./ui_util.ts";
import * as user_pill from "./user_pill.ts";
import {user_settings} from "./user_settings.ts";

// The scheduler shows, for a week from the date of the event in the
// form, when its attendees are busy or out of their work hours, and
// changes the event's time and attendees in the form.

const SHOWN_DAYS = 7;
const MINUTES_PER_DAY = 24 * 60;
// "Find a time" looks this many weeks ahead.
const FIND_WEEKS = 4;
const TIME_SCALES = [15, 30, 60];
// Free, and working elsewhere, as in the suggestions of the form.
const FREE_SHOW_AS = new Set([1, 5]);
const OPTIONS_KEY = "calendar_scheduler_options";

const block_schema = z.object({
    start: z.number(),
    end: z.number(),
    show_as: z.number(),
    event_id: z.nullable(z.number()),
    title: z.nullable(z.string()),
});

const working_hours_schema = z.object({
    timezone: z.string(),
    work_days: z.array(z.number()),
    work_day_start_minutes: z.number(),
    work_day_end_minutes: z.number(),
});

const response_schema = z.object({
    free_busy: z.record(z.string(), z.array(block_schema)),
    working_hours: z.record(z.string(), working_hours_schema),
    room_free_busy: z.record(z.string(), z.array(block_schema)),
});

type Block = z.infer<typeof block_schema>;
type WorkingHours = z.infer<typeof working_hours_schema>;
type Interval = {start: number; end: number};
type Segment = {start: number; span: number};
type Options = {only_work_hours: boolean; scale: number};

let is_scheduling = false;
// The first of the days shown.
let first_date = "";
let free_busy = new Map<number, Block[]>();
let working_hours = new Map<number, WorkingHours>();
let room_free_busy = new Map<number, Block[]>();
let load_state: "loading" | "loaded" | "error" = "loading";
let request_id = 0;
const collapsed_sections = new Set<string>();

export function is_open(): boolean {
    return is_scheduling;
}

function get_options(): Options {
    const options = z
        .object({only_work_hours: z.boolean(), scale: z.number()})
        .safeParse(localstorage().get(OPTIONS_KEY));
    return options.success && TIME_SCALES.includes(options.data.scale)
        ? options.data
        : {only_work_hours: true, scale: 30};
}

function set_options(options: Options): void {
    localstorage().set(OPTIONS_KEY, options);
    render();
}

// The minutes of each day shown: the user's work hours, or the whole
// day.
function get_shown_minutes(): {start: number; end: number} {
    if (!get_options().only_work_hours) {
        return {start: 0, end: MINUTES_PER_DAY};
    }
    return calendar_grid.get_work_hours();
}

function get_dates(): string[] {
    const first = calendar_util.parse_date(first_date)!;
    return Array.from({length: SHOWN_DAYS}, (_, index) =>
        calendar_util.format_date(addDays(first, index)),
    );
}

// The parts of an interval that the scheduler shows, in minutes from
// the start of the first day shown, counting only the minutes shown.
function get_segments(interval: Interval, time_zone: string): Segment[] {
    const shown = get_shown_minutes();
    const day_minutes = shown.end - shown.start;
    const segments = [];
    for (const [index, date] of get_dates().entries()) {
        const day_start = calendar_layout.get_day_start(date, time_zone);
        const shown_start = day_start + shown.start * 60;
        const shown_end = day_start + shown.end * 60;
        const start = Math.max(interval.start, shown_start);
        const end = Math.min(interval.end, shown_end);
        if (start < end) {
            segments.push({
                start: index * day_minutes + (start - shown_start) / 60,
                span: (end - start) / 60,
            });
        }
    }
    return segments;
}

// When someone works, in their own timezone, around the days shown.
function get_work_intervals(user_id: number, time_zone: string): Interval[] | undefined {
    const hours = working_hours.get(user_id);
    if (hours === undefined) {
        return undefined;
    }
    const work_time_zone = hours.timezone || time_zone;
    const first = calendar_util.parse_date(first_date)!;
    const intervals = [];
    for (let offset = -1; offset <= SHOWN_DAYS; offset += 1) {
        const date = addDays(first, offset);
        if (hours.work_days.includes(getISODay(date))) {
            const day_start = calendar_layout.get_day_start(
                calendar_util.format_date(date),
                work_time_zone,
            );
            intervals.push({
                start: day_start + hours.work_day_start_minutes * 60,
                end: day_start + hours.work_day_end_minutes * 60,
            });
        }
    }
    return intervals;
}

function subtract(intervals: Interval[], removed: Interval[]): Interval[] {
    let result = intervals;
    for (const cut of removed) {
        result = result.flatMap((interval) =>
            [
                {start: interval.start, end: Math.min(interval.end, cut.start)},
                {start: Math.max(interval.start, cut.end), end: interval.end},
            ].filter((part) => part.start < part.end),
        );
    }
    return result;
}

function get_selection(state: SchedulingState): Interval {
    const start = calendar_layout.get_day_start(state.date, state.time_zone);
    if (state.is_all_day) {
        return {start, end: calendar_layout.get_day_start(state.date, state.time_zone, 1)};
    }
    return {
        start: start + state.start_minute * 60,
        end: start + (state.start_minute + state.duration_minutes) * 60,
    };
}

function get_busy_blocks(user_id: number, state: SchedulingState): Block[] {
    return (free_busy.get(user_id) ?? []).filter(
        (block) => !FREE_SHOW_AS.has(block.show_as) && block.event_id !== state.event_id,
    );
}

function get_room_blocks(room_id: number, state: SchedulingState): Block[] {
    return (room_free_busy.get(room_id) ?? []).filter((block) => block.event_id !== state.event_id);
}

function overlaps(block: Block, interval: Interval): boolean {
    return block.start < interval.end && block.end > interval.start;
}

// A room is available whenever no other meeting booked it.
function is_room_available(room_id: number, interval: Interval, state: SchedulingState): boolean {
    return get_room_blocks(room_id, state).every((block) => !overlaps(block, interval));
}

// Someone is unavailable when they are busy, or out of their work
// hours, at the time.
function is_available(user_id: number, interval: Interval, state: SchedulingState): boolean {
    const is_busy = get_busy_blocks(user_id, state).some((block) => overlaps(block, interval));
    const work_intervals = get_work_intervals(user_id, state.time_zone);
    const is_working =
        work_intervals === undefined ||
        work_intervals.some((work) => work.start <= interval.start && work.end >= interval.end);
    return !is_busy && is_working;
}

function format_time(seconds: number, time_zone: string): string {
    return new Intl.DateTimeFormat(user_settings.default_language, {
        hour: "numeric",
        minute: "2-digit",
        hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
        timeZone: time_zone,
    }).format(new Date(seconds * 1000));
}

function format_date(date: string, options: Intl.DateTimeFormatOptions): string {
    return calendar_util.capitalize(
        new Intl.DateTimeFormat(user_settings.default_language, {
            ...options,
            timeZone: "UTC",
        }).format(new Date(`${date}T12:00:00Z`)),
        user_settings.default_language,
    );
}

function to_segment_context(segments: Segment[]): Segment[] {
    return segments.map(({start, span}) => ({start, span}));
}

function get_person_row(
    user_id: number,
    state: SchedulingState,
    section: string,
    can_remove: boolean,
): Record<string, unknown> {
    const user = people.maybe_get_user_by_id(user_id, true);
    const name = user?.full_name ?? $t({defaultMessage: "Unknown user"});
    const selection = get_selection(state);
    const hours = working_hours.get(user_id);
    const time_zone = hours?.timezone || state.time_zone;
    const local_start = new TZDate(selection.start * 1000, time_zone);
    const work_intervals = get_work_intervals(user_id, state.time_zone);
    const dates = get_dates();
    const shown = get_shown_minutes();
    const shown_intervals = dates.map((date) => {
        const day_start = calendar_layout.get_day_start(date, state.time_zone);
        return {start: day_start + shown.start * 60, end: day_start + shown.end * 60};
    });
    return {
        kind: "person",
        is_hidden: collapsed_sections.has(section),
        user_id,
        name,
        avatar_url: user === undefined ? "" : people.small_avatar_url_for_person(user),
        is_unavailable: load_state === "loaded" && !is_available(user_id, selection, state),
        local_day: format_date(calendar_util.format_date(local_start), {weekday: "long"}),
        local_time: `${format_time(selection.start, time_zone)} ${timerender.get_utc_offset_string(time_zone, local_start)}`,
        can_remove,
        remove_label: $t({defaultMessage: "Remove {name}"}, {name}),
        has_no_data: load_state === "error" || (load_state === "loaded" && !free_busy.has(user_id)),
        off_hours:
            work_intervals === undefined
                ? []
                : to_segment_context(
                      subtract(shown_intervals, work_intervals).flatMap((interval) =>
                          get_segments(interval, state.time_zone),
                      ),
                  ),
        blocks: get_busy_blocks(user_id, state).flatMap((block) =>
            get_block_context(
                block,
                state,
                calendar_grid.get_free_busy_status(block.show_as).class_name,
            ),
        ),
    };
}

function get_block_context(
    block: Block,
    state: SchedulingState,
    class_name: string,
): Record<string, unknown>[] {
    const status = calendar_grid.get_free_busy_status(block.show_as);
    const label = `${block.title ?? status.label}, ${format_time(block.start, state.time_zone)} – ${format_time(block.end, state.time_zone)}`;
    return get_segments(block, state.time_zone).map((segment) => ({
        ...segment,
        class_name,
        label,
    }));
}

function get_room_row(room_id: number, state: SchedulingState): Record<string, unknown> {
    const room = calendar_rooms.maybe_get_room(room_id);
    const name = calendar_rooms.get_room_name(room_id);
    return {
        kind: "room",
        is_hidden: collapsed_sections.has("rooms"),
        room_id,
        name,
        details: room === undefined ? "" : calendar_rooms.get_room_details(room),
        is_unavailable:
            load_state === "loaded" && !is_room_available(room_id, get_selection(state), state),
        can_remove: state.can_change_attendees,
        remove_label: $t({defaultMessage: "Remove {name}"}, {name}),
        has_no_data:
            load_state === "error" || (load_state === "loaded" && !room_free_busy.has(room_id)),
        blocks: get_room_blocks(room_id, state).flatMap((block) =>
            get_block_context(block, state, "busy"),
        ),
    };
}

function get_room_rows(state: SchedulingState): Record<string, unknown>[] {
    const is_collapsed = collapsed_sections.has("rooms");
    return [
        {
            kind: "section",
            section: "rooms",
            title: $t({defaultMessage: "Rooms"}),
            is_collapsed,
        },
        ...state.room_ids.map((room_id) => get_room_row(room_id, state)),
        ...(state.can_change_attendees
            ? [
                  {
                      kind: "add",
                      section: "rooms",
                      placeholder: $t({defaultMessage: "Add a room"}),
                      is_hidden: is_collapsed,
                  },
              ]
            : []),
    ];
}

function get_availability_row(user_ids: number[], state: SchedulingState): Record<string, unknown> {
    const busy = [
        ...user_ids.flatMap((user_id) => get_busy_blocks(user_id, state)),
        ...state.room_ids.flatMap((room_id) => get_room_blocks(room_id, state)),
    ];
    return {
        kind: "availability",
        blocks: busy.flatMap((block) =>
            get_segments(block, state.time_zone).map((segment) => ({
                ...segment,
                class_name: "busy",
                label: calendar_grid.get_free_busy_status(block.show_as).label,
            })),
        ),
    };
}

function get_section_rows(
    section: "required" | "optional",
    user_ids: number[],
    state: SchedulingState,
): Record<string, unknown>[] {
    const is_collapsed = collapsed_sections.has(section);
    const title =
        section === "required"
            ? $t({defaultMessage: "Required attendees"})
            : $t({defaultMessage: "Optional attendees"});
    const placeholder =
        section === "required"
            ? $t({defaultMessage: "Add a required attendee"})
            : $t({defaultMessage: "Add an optional attendee"});
    return [
        {kind: "section", section, title, is_collapsed},
        ...user_ids.map((user_id) =>
            get_person_row(
                user_id,
                state,
                section,
                state.can_change_attendees && user_id !== current_user.user_id,
            ),
        ),
        ...(state.can_change_attendees
            ? [{kind: "add", section, placeholder, is_hidden: is_collapsed}]
            : []),
    ];
}

function get_context(state: SchedulingState): Record<string, unknown> {
    const options = get_options();
    const shown = get_shown_minutes();
    const day_minutes = shown.end - shown.start;
    const required_ids = [current_user.user_id, ...state.required_attendee_ids];
    const selection_segments = get_segments(get_selection(state), state.time_zone);
    const first_segment = selection_segments[0];
    const last_segment = selection_segments.at(-1);
    // At the largest scale, an hour is too narrow for its label.
    const label_minutes = options.scale === 60 ? 120 : 60;
    const hours: {label: string; minutes: number}[] = [];
    for (
        let minute = Math.ceil(shown.start / 60) * 60;
        minute < shown.end;
        minute += label_minutes
    ) {
        hours.push({
            label: calendar_form.format_minutes(minute),
            minutes: Math.min(label_minutes, shown.end - minute),
        });
    }
    if (shown.start % 60 !== 0) {
        hours.unshift({label: "", minutes: 60 - (shown.start % 60)});
    }
    const date_label = format_date(state.date, {day: "2-digit", month: "2-digit", year: "numeric"});
    return {
        scale: options.scale,
        day_minutes,
        total_minutes: day_minutes * SHOWN_DAYS,
        date_label,
        date_aria_label: $t({defaultMessage: "Date: {date}"}, {date: date_label}),
        is_all_day: state.is_all_day,
        days: get_dates().map((date) => ({
            label: format_date(date, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
            }),
            is_selected: date === state.date,
            hours,
        })),
        // Every row has a track, which may be empty.
        rows: [
            get_availability_row(required_ids, state),
            ...get_section_rows("required", required_ids, state),
            ...get_section_rows("optional", state.optional_attendee_ids, state),
            ...get_room_rows(state),
        ].map((row) => ({off_hours: [], blocks: [], ...row})),
        has_selection: first_segment !== undefined,
        selection:
            first_segment === undefined || last_segment === undefined
                ? {start: 0, span: 0}
                : {
                      start: first_segment.start,
                      span: last_segment.start + last_segment.span - first_segment.start,
                  },
        selection_label: state.is_all_day
            ? date_label
            : `${date_label} ${calendar_form.format_minutes(state.start_minute)} – ${calendar_form.format_minutes(state.start_minute + state.duration_minutes)}`,
        legend: [
            ...calendar_grid
                .get_legend()
                .filter(({class_name}) => class_name !== "free")
                .map(({class_name, label}) => ({
                    swatch_class: `calendar-event free-busy ${class_name}`,
                    label,
                })),
            {
                swatch_class: "calendar-scheduler-no-data-swatch",
                label: $t({defaultMessage: "No data"}),
            },
            {
                swatch_class: "calendar-scheduler-off-hours-swatch",
                label: $t({defaultMessage: "Outside of work hours"}),
            },
        ],
    };
}

function set_up_add_pills(state: SchedulingState): void {
    $("#calendar-view .calendar-scheduler-add").each(function () {
        const $container = $(this);
        if ($container.attr("data-section") === "rooms") {
            calendar_rooms.set_up_typeahead(
                $container.find(".input"),
                (room_id) => {
                    calendar_form.add_room(room_id);
                    fetch();
                },
                () => state.room_ids,
            );
            return;
        }
        const is_required = $container.attr("data-section") === "required";
        const pills = user_pill.create_pills($container, {exclude_inaccessible_users: true});
        pill_typeahead.set_up_user($container.find(".input"), pills, {
            exclude_bots: true,
            exclude_user_ids: [
                current_user.user_id,
                ...state.required_attendee_ids,
                ...state.optional_attendee_ids,
            ],
        });
        pills.onPillCreate(() => {
            for (const user_id of user_pill.get_user_ids(pills)) {
                calendar_form.add_attendee(user_id, is_required);
            }
            fetch();
        });
    });
}

function render(): void {
    if (!is_scheduling) {
        return;
    }
    const state = calendar_form.get_scheduling_state();
    const $container = $("#calendar-view .calendar-scheduler-container");
    const scroll_left = $container.find(".calendar-scheduler-scroll").scrollLeft();
    $container.html(render_calendar_scheduler(get_context(state)));
    if (!state.is_all_day) {
        calendar_form.fill_time_selects(
            $container.find(".calendar-scheduler-start"),
            $container.find(".calendar-scheduler-end"),
            state.start_minute,
            state.duration_minutes,
        );
    }
    set_up_add_pills(state);
    if (scroll_left !== undefined) {
        $container.find(".calendar-scheduler-scroll").scrollLeft(scroll_left);
    }
}

function scroll_to_selection(): void {
    $("#calendar-view .calendar-scheduler-selection")
        .get(0)
        ?.scrollIntoView({block: "nearest", inline: "center"});
}

function fetch(on_loaded?: () => void): void {
    const state = calendar_form.get_scheduling_state();
    const user_ids = [
        current_user.user_id,
        ...state.required_attendee_ids,
        ...state.optional_attendee_ids,
    ];
    request_id += 1;
    const this_request_id = request_id;
    load_state = "loading";
    render();
    void channel.get({
        url: "/json/calendar/free_busy",
        data: {
            user_ids: JSON.stringify(user_ids),
            room_ids: JSON.stringify(state.room_ids),
            start: calendar_layout.get_day_start(first_date, state.time_zone),
            end: calendar_layout.get_day_start(first_date, state.time_zone, SHOWN_DAYS),
        },
        success(raw_data) {
            if (this_request_id !== request_id || !is_scheduling) {
                return;
            }
            const data = response_schema.parse(raw_data);
            free_busy = new Map(
                Object.entries(data.free_busy).map(([user_id, blocks]) => [
                    Number(user_id),
                    blocks,
                ]),
            );
            working_hours = new Map(
                Object.entries(data.working_hours).map(([user_id, hours]) => [
                    Number(user_id),
                    hours,
                ]),
            );
            room_free_busy = new Map(
                Object.entries(data.room_free_busy).map(([room_id, blocks]) => [
                    Number(room_id),
                    blocks,
                ]),
            );
            load_state = "loaded";
            render();
            on_loaded?.();
        },
        error() {
            if (this_request_id === request_id && is_scheduling) {
                load_state = "error";
                render();
            }
        },
    });
}

// Shows the week of the event, if it moved out of the days shown.
function update_days(): void {
    const state = calendar_form.get_scheduling_state();
    if (!get_dates().includes(state.date)) {
        first_date = state.date;
        fetch(scroll_to_selection);
    } else {
        render();
    }
}

function move_selection_to(offset: number): void {
    const state = calendar_form.get_scheduling_state();
    const shown = get_shown_minutes();
    const day_minutes = shown.end - shown.start;
    const scale = get_options().scale;
    const span = state.is_all_day ? 0 : state.duration_minutes;
    const snapped = Math.round(offset / scale) * scale;
    const clamped = Math.max(
        0,
        Math.min(snapped, day_minutes * SHOWN_DAYS - Math.min(span, day_minutes)),
    );
    const day_index = Math.min(Math.floor(clamped / day_minutes), SHOWN_DAYS - 1);
    const date = get_dates()[day_index]!;
    if (date !== state.date) {
        calendar_form.set_date(date);
    }
    if (!state.is_all_day) {
        calendar_form.set_time(
            shown.start + clamped - day_index * day_minutes,
            state.duration_minutes,
        );
    }
    render();
}

function get_minute_width(): number {
    const shown = get_shown_minutes();
    const $day = $("#calendar-view .calendar-scheduler-day").first();
    return ($day.outerWidth() ?? 1) / (shown.end - shown.start);
}

function get_selection_offset(): number {
    const selection = $("#calendar-view .calendar-scheduler-selection").get(0);
    return Number(selection?.style.getPropertyValue("--calendar-scheduler-start") ?? 0);
}

// The next time after the one chosen, in the user's work hours, when
// everyone required and the rooms are available, looking up to
// FIND_WEEKS weeks ahead.
function find_time(weeks_searched = 0): void {
    const state = calendar_form.get_scheduling_state();
    if (state.is_all_day) {
        return;
    }
    const required_ids = [current_user.user_id, ...state.required_attendee_ids];
    const after = weeks_searched === 0 ? get_selection(state).start : 0;
    const work = calendar_grid.get_work_hours();
    const step = get_options().scale;
    for (const date of get_dates()) {
        const day_start = calendar_layout.get_day_start(date, state.time_zone);
        for (let minute = work.start; minute + state.duration_minutes <= work.end; minute += step) {
            const interval = {
                start: day_start + minute * 60,
                end: day_start + (minute + state.duration_minutes) * 60,
            };
            if (
                interval.start > after &&
                interval.start > Date.now() / 1000 &&
                required_ids.every((user_id) => is_available(user_id, interval, state)) &&
                state.room_ids.every((room_id) => is_room_available(room_id, interval, state))
            ) {
                calendar_form.set_date(date);
                calendar_form.set_time(minute, state.duration_minutes);
                render();
                scroll_to_selection();
                return;
            }
        }
    }
    if (weeks_searched + 1 >= FIND_WEEKS) {
        $("#calendar-view .calendar-scheduler-error")
            .text(
                $t(
                    {
                        defaultMessage:
                            "Everyone required is not free in your work hours in the next {weeks} weeks.",
                    },
                    {weeks: FIND_WEEKS},
                ),
            )
            .addClass("shown");
        return;
    }
    first_date = calendar_util.format_date(
        addDays(calendar_util.parse_date(first_date)!, SHOWN_DAYS),
    );
    fetch(() => {
        find_time(weeks_searched + 1);
    });
}

function show_options_menu(button: HTMLElement): void {
    popover_menus.toggle_popover_menu(button, {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            const options = get_options();
            instance.setContent(
                ui_util.parse_html(
                    render_calendar_scheduler_options_popover({
                        only_work_hours: options.only_work_hours,
                        scales: TIME_SCALES.map((minutes) => ({
                            minutes,
                            label: $t({defaultMessage: "{minutes} minutes"}, {minutes}),
                            is_checked: minutes === options.scale,
                        })),
                    }),
                ),
            );
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            $popper.on("click", ".calendar-scheduler-work-hours-option", () => {
                popover_menus.hide_current_popover_if_visible(instance);
                const options = get_options();
                set_options({...options, only_work_hours: !options.only_work_hours});
            });
            $popper.on("click", ".calendar-scheduler-scale-option", function (this: HTMLElement) {
                popover_menus.hide_current_popover_if_visible(instance);
                set_options({...get_options(), scale: Number(this.dataset["scale"])});
            });
        },
        onHidden(instance) {
            instance.destroy();
        },
    });
}

export function open(): void {
    const state = calendar_form.get_scheduling_state();
    is_scheduling = true;
    first_date = state.date;
    free_busy = new Map();
    working_hours = new Map();
    $("#calendar-view").addClass("scheduling");
    fetch(scroll_to_selection);
    $("#calendar-view .calendar-scheduler-back").trigger("focus");
}

export function close(): void {
    if (!is_scheduling) {
        return;
    }
    is_scheduling = false;
    $("#calendar-view").removeClass("scheduling");
    $("#calendar-view .calendar-scheduler-container").empty();
}

// Draws the scheduler again when the calendar shows again.
export function restore(): void {
    if (is_scheduling) {
        $("#calendar-view").addClass("scheduling");
        render();
    }
}

function back(): void {
    close();
    $("#calendar-view .calendar-form-scheduler").trigger("focus");
}

export function initialize(): void {
    const $view = $("#calendar-view");
    const selector = (child: string): string => `.calendar-scheduler ${child}`;
    $view.on("click", ".calendar-form-scheduler", () => {
        open();
    });
    $view.on("click", selector(".calendar-scheduler-back"), back);
    $view.on("keydown", ".calendar-scheduler", (e) => {
        if (e.key === "Escape" && !popovers.any_active()) {
            e.preventDefault();
            back();
        }
    });
    // The form shows any error in saving.
    $view.on("click", selector(".calendar-scheduler-save"), () => {
        close();
        calendar_form.save();
    });
    $view.on("click", selector(".calendar-scheduler-options"), function (this: HTMLElement) {
        show_options_menu(this);
    });
    $view.on("click", selector(".calendar-scheduler-date"), function (this: HTMLElement) {
        calendar_form.show_date_picker(this, calendar_form.get_scheduling_state().date, (date) => {
            calendar_form.set_date(date);
            update_days();
        });
    });
    $view.on("change", selector(".calendar-scheduler-start"), function (this: HTMLElement) {
        const state = calendar_form.get_scheduling_state();
        calendar_form.set_time(Number($(this).val()), state.duration_minutes);
        render();
    });
    $view.on("change", selector(".calendar-scheduler-end"), function (this: HTMLElement) {
        const state = calendar_form.get_scheduling_state();
        calendar_form.set_time(state.start_minute, Number($(this).val()));
        render();
    });
    $view.on(
        "change",
        selector(".calendar-scheduler-all-day-checkbox"),
        function (this: HTMLElement) {
            calendar_form.set_all_day($(this).prop("checked") === true);
            render();
        },
    );
    $view.on("click", selector(".calendar-scheduler-section-toggle"), function (this: HTMLElement) {
        const section = this.dataset["section"]!;
        if (collapsed_sections.has(section)) {
            collapsed_sections.delete(section);
        } else {
            collapsed_sections.add(section);
        }
        render();
    });
    $view.on("click", selector(".calendar-scheduler-remove"), function (this: HTMLElement) {
        if (this.dataset["roomId"] === undefined) {
            calendar_form.remove_attendee(Number(this.dataset["userId"]));
        } else {
            calendar_form.remove_room(Number(this.dataset["roomId"]));
        }
        render();
    });
    $view.on("click", selector(".calendar-scheduler-find"), () => {
        $("#calendar-view .calendar-scheduler-error").removeClass("shown");
        find_time();
    });
    // Clicking a time moves the event there; dragging the selection
    // moves it along.
    $view.on("pointerdown", selector(".calendar-scheduler-track"), function (this: HTMLElement, e) {
        const event = e.originalEvent as PointerEvent;
        const left = this.getBoundingClientRect().left;
        move_selection_to((event.clientX - left) / get_minute_width());
    });
    $view.on(
        "pointerdown",
        selector(".calendar-scheduler-selection"),
        function (this: HTMLElement, e) {
            const event = e.originalEvent as PointerEvent;
            event.preventDefault();
            const start_x = event.clientX;
            const start_offset = get_selection_offset();
            const minute_width = get_minute_width();
            const selection = this;
            selection.setPointerCapture(event.pointerId);
            const on_move = (move: PointerEvent): void => {
                const offset = start_offset + (move.clientX - start_x) / minute_width;
                selection.style.setProperty(
                    "--calendar-scheduler-start",
                    String(Math.max(0, offset)),
                );
            };
            const on_up = (up: PointerEvent): void => {
                selection.removeEventListener("pointermove", on_move);
                selection.removeEventListener("pointerup", on_up);
                move_selection_to(start_offset + (up.clientX - start_x) / minute_width);
            };
            selection.addEventListener("pointermove", on_move);
            selection.addEventListener("pointerup", on_up);
        },
    );
    $view.on("keydown", selector(".calendar-scheduler-selection"), (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
            return;
        }
        e.preventDefault();
        const step = get_options().scale;
        move_selection_to(get_selection_offset() + (e.key === "ArrowLeft" ? -step : step));
        $("#calendar-view .calendar-scheduler-selection").trigger("focus");
    });
}
