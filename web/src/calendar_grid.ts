import {TZDate} from "@date-fns/tz";
import {format} from "date-fns";
import {$} from "jquery";
import assert from "minimalistic-assert";
import * as z from "zod/mini";

import render_calendar_all_day_events from "../templates/calendar/calendar_all_day_events.hbs";
import render_calendar_day_events from "../templates/calendar/calendar_day_events.hbs";
import render_calendar_grid from "../templates/calendar/calendar_grid.hbs";
import render_calendar_grid_error from "../templates/calendar/calendar_grid_error.hbs";

import * as calendar_layout from "./calendar_layout.ts";
import type {AllDayEventPlacement, TimedEventPlacement} from "./calendar_layout.ts";
import * as calendar_util from "./calendar_util.ts";
import type {CalendarLocation} from "./calendar_util.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import {current_user} from "./state_data.ts";
import * as timerender from "./timerender.ts";
import {user_settings} from "./user_settings.ts";

// The values of CalendarShowAs and CalendarResponse on the server.
const SHOW_AS_FREE = 1;
const SHOW_AS_TENTATIVE = 2;
const RESPONSE_TENTATIVE = 3;

// Outlook's default color categories, by the names Exchange stores.
const CATEGORY_COLORS = new Map([
    ["Red category", "#d13438"],
    ["Orange category", "#ca5010"],
    ["Yellow category", "#c19c00"],
    ["Green category", "#13a10e"],
    ["Blue category", "#0078d4"],
    ["Purple category", "#8764b8"],
]);

// Events are never drawn shorter than half a row of the grid, which
// fits a line of their title, and which half-hour events at the
// largest time scale fill without overlapping.
const MIN_EVENT_ROWS = 0.5;
const MINUTES_PER_DAY = 24 * 60;

const settings_schema = z.object({
    settings: z.object({
        work_days: z.array(z.number()),
        work_day_start_minutes: z.number(),
        work_day_end_minutes: z.number(),
        time_scale_minutes: z.number(),
    }),
});

type CalendarSettings = z.infer<typeof settings_schema>["settings"];

const occurrence_schema = z.object({
    id: z.number(),
    original_start: z.nullable(z.number()),
    start: z.number(),
    end: z.number(),
    timezone: z.string(),
    is_all_day: z.boolean(),
    title: z.string(),
    show_as: z.number(),
    is_cancelled: z.boolean(),
    response: z.number(),
    organizer_id: z.number(),
    category: z.string(),
    attendees: z.array(z.object({user_id: z.number()})),
});

type CalendarOccurrence = z.infer<typeof occurrence_schema>;

const events_schema = z.object({events: z.array(occurrence_schema)});

let settings: CalendarSettings = {
    work_days: [1, 2, 3, 4, 5],
    work_day_start_minutes: 9 * 60,
    work_day_end_minutes: 18 * 60,
    time_scale_minutes: 30,
};
let settings_state: "unloaded" | "loading" | "loaded" = "unloaded";
let on_settings_loaded: (() => void) | undefined;

let current_location: CalendarLocation | undefined;
let occurrences: CalendarOccurrence[] = [];
let load_state: "loading" | "loaded" | "error" = "loading";
// Responses to requests for a week that is no longer shown are
// dropped.
let request_id = 0;
let now_timer: ReturnType<typeof setInterval> | undefined;
// The grid opens at the start of the work day once the week is
// loaded, since all-day events above the hours move them down.
let should_scroll_to_work_day = false;
let rendered_today: string | undefined;

// The user's timezone, which the calendar shows times in, like a
// mailbox in Outlook.
export function get_time_zone(): string {
    return user_settings.timezone || timerender.display_time_zone;
}

export function get_today(): string {
    return format(new TZDate(Date.now(), get_time_zone()), "yyyy-MM-dd");
}

export function get_work_days(): number[] {
    return settings.work_days;
}

function format_time(seconds: number): string {
    return new Intl.DateTimeFormat(user_settings.default_language, {
        hour: "numeric",
        minute: "2-digit",
        hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
        timeZone: get_time_zone(),
    }).format(seconds * 1000);
}

function format_hour(hour: number): string {
    if (user_settings.twenty_four_hour_time) {
        return String(hour);
    }
    return new Intl.DateTimeFormat(user_settings.default_language, {
        hour: "numeric",
        hourCycle: user_settings.twenty_four_hour_time ? "h23" : "h12",
    }).format(new Date(2000, 0, 1, hour));
}

function get_shown_dates(): string[] {
    assert(current_location !== undefined);
    return calendar_util
        .get_shown_days(current_location, settings.work_days)
        .map((day) => calendar_util.format_date(day));
}

function is_personal_event(occurrence: CalendarOccurrence): boolean {
    return (
        occurrence.organizer_id === current_user.user_id &&
        occurrence.attendees.every((attendee) => attendee.user_id === current_user.user_id)
    );
}

// An event the user may not go to: shown so, or answered so.
function is_tentative(occurrence: CalendarOccurrence): boolean {
    return (
        occurrence.show_as === SHOW_AS_TENTATIVE || occurrence.response === RESPONSE_TENTATIVE
    );
}

function get_event_class_names(occurrence: CalendarOccurrence): string {
    return [
        is_personal_event(occurrence) ? "personal" : "meeting",
        occurrence.is_cancelled && "cancelled",
        is_tentative(occurrence) && "tentative",
        occurrence.show_as === SHOW_AS_FREE && "free",
        occurrence.original_start !== null && "recurring",
    ]
        .filter(Boolean)
        .join(" ");
}

function get_event_context(occurrence: CalendarOccurrence): Record<string, unknown> {
    const organizer =
        occurrence.organizer_id === current_user.user_id
            ? undefined
            : people.maybe_get_user_by_id(occurrence.organizer_id, true);
    const title = occurrence.is_cancelled
        ? $t({defaultMessage: "Canceled: {title}"}, {title: occurrence.title})
        : occurrence.title;
    const time = occurrence.is_all_day
        ? $t({defaultMessage: "All day"})
        : `${format_time(occurrence.start)} – ${format_time(occurrence.end)}`;
    let status: string | undefined;
    if (is_tentative(occurrence)) {
        status = $t({defaultMessage: "Tentative"});
    } else if (occurrence.show_as === SHOW_AS_FREE) {
        status = $t({defaultMessage: "Free"});
    }
    return {
        title,
        organizer_name: organizer?.full_name,
        class_names: get_event_class_names(occurrence),
        is_recurring: occurrence.original_start !== null,
        category_color: CATEGORY_COLORS.get(occurrence.category),
        label: [title, time, organizer?.full_name, status].filter(Boolean).join(", "),
    };
}

function get_timed_event_context(
    placement: TimedEventPlacement<CalendarOccurrence>,
): Record<string, unknown> {
    const percent = (minutes: number): number => (minutes / MINUTES_PER_DAY) * 100;
    const min_minutes = settings.time_scale_minutes * MIN_EVENT_ROWS;
    const height = Math.max(placement.end_minute - placement.start_minute, min_minutes);
    const context = get_event_context(placement.event);
    return {
        ...context,
        // Events shorter than a row only have room for their title.
        class_names:
            height < settings.time_scale_minutes
                ? `${String(context["class_names"])} short`
                : context["class_names"],
        top: percent(placement.start_minute),
        height: percent(height),
        left: (placement.column / placement.column_count) * 100,
        width: 100 / placement.column_count,
    };
}

function get_all_day_event_context(
    placement: AllDayEventPlacement<CalendarOccurrence>,
): Record<string, unknown> {
    return {
        ...get_event_context(placement.event),
        // The first grid column holds the hours.
        grid_column_start: placement.first_day + 2,
        grid_column_end: placement.last_day + 3,
        grid_row: placement.lane + 1,
    };
}

function render_events(): void {
    const dates = get_shown_dates();
    const layout = calendar_layout.get_week_layout(
        load_state === "loaded" ? occurrences : [],
        dates,
        get_time_zone(),
        settings.time_scale_minutes * MIN_EVENT_ROWS,
    );
    const $grid = $("#calendar-view .calendar-grid");
    $grid.find(".calendar-day-column").each(function (index) {
        $(this)
            .find(".calendar-day-events")
            .html(
                render_calendar_day_events({
                    events: layout.days[index]!.map((placement) =>
                        get_timed_event_context(placement),
                    ),
                }),
            );
    });
    $grid.find(".calendar-all-day-events").html(
        render_calendar_all_day_events({
            events: layout.all_day.map((placement) => get_all_day_event_context(placement)),
        }),
    );
    $grid.toggleClass("has-all-day-events", layout.all_day_lane_count > 0);
    $grid.toggleClass("loading", load_state === "loading");
    $grid.toggleClass("load-failed", load_state === "error");
    $("#calendar-view .calendar-grid-error-container").html(
        load_state === "error" ? render_calendar_grid_error() : "",
    );
}

function update_now_line(): void {
    const today = get_today();
    if (today !== rendered_today) {
        // The day changed at midnight.
        render_grid();
        return;
    }
    const $line = $("#calendar-view .calendar-day-column.today .calendar-now-line");
    const now = new TZDate(Date.now(), get_time_zone());
    const minutes = now.getHours() * 60 + now.getMinutes();
    $line.css("top", `${(minutes / MINUTES_PER_DAY) * 100}%`);
}

function render_grid(): void {
    assert(current_location !== undefined);
    const today = get_today();
    rendered_today = today;
    const rows_per_hour = 60 / settings.time_scale_minutes;
    $("#calendar-view .calendar-grid-container").html(
        render_calendar_grid({
            day_count: get_shown_dates().length,
            rows_per_hour,
            days: calendar_util.get_shown_days(current_location, settings.work_days).map((day) => {
                const date = calendar_util.format_date(day);
                return {
                    date,
                    number: format(day, "dd"),
                    weekday: calendar_util.capitalize(
                        new Intl.DateTimeFormat(user_settings.default_language, {
                            weekday: "short",
                        }).format(day),
                        user_settings.default_language,
                    ),
                    label: new Intl.DateTimeFormat(user_settings.default_language, {
                        dateStyle: "full",
                    }).format(day),
                    is_today: date === today,
                };
            }),
            hours: Array.from({length: 23}, (_, index) => ({
                label: format_hour(index + 1),
                top: ((index + 1) / 24) * 100,
            })),
        }),
    );
    render_events();
    update_now_line();
}

function scroll_to_work_day_start(): void {
    const $container = $("#calendar-view .calendar-grid-container");
    const column = $container.find(".calendar-day-column").get(0);
    const top = $container.find(".calendar-grid-top").get(0);
    if (column === undefined || top === undefined) {
        return;
    }
    // Leave the half hour before the work day in sight, right under
    // the day headers, which stay at the top.
    const minutes = Math.max(settings.work_day_start_minutes - 30, 0);
    const column_rect = column.getBoundingClientRect();
    const offset = (minutes / MINUTES_PER_DAY) * column_rect.height;
    $container.scrollTop(
        ($container.scrollTop() ?? 0) +
            column_rect.top +
            offset -
            top.getBoundingClientRect().bottom,
    );
}

function maybe_scroll_to_work_day_start(): void {
    if (should_scroll_to_work_day && load_state !== "loading") {
        should_scroll_to_work_day = false;
        scroll_to_work_day_start();
    }
}

function fetch_events(): void {
    assert(current_location !== undefined);
    const dates = calendar_util
        .get_shown_days({...current_location, view: "week"}, settings.work_days)
        .map((day) => calendar_util.format_date(day));
    const time_zone = get_time_zone();
    request_id += 1;
    const this_request_id = request_id;
    void channel.get({
        url: "/json/calendar/events",
        data: {
            start: calendar_layout.get_day_start(dates[0]!, time_zone),
            end: calendar_layout.get_day_start(dates.at(-1)!, time_zone, 1),
        },
        success(raw_data) {
            if (this_request_id !== request_id) {
                return;
            }
            occurrences = events_schema.parse(raw_data).events;
            load_state = "loaded";
            if (calendar_util.is_visible()) {
                render_events();
                maybe_scroll_to_work_day_start();
            }
        },
        error() {
            if (this_request_id !== request_id) {
                return;
            }
            load_state = "error";
            if (calendar_util.is_visible()) {
                render_events();
                maybe_scroll_to_work_day_start();
            }
        },
    });
}

function fetch_settings(): void {
    settings_state = "loading";
    void channel.get({
        url: "/json/calendar/settings",
        success(raw_data) {
            settings = settings_schema.parse(raw_data).settings;
            settings_state = "loaded";
            if (calendar_util.is_visible()) {
                render_grid();
                should_scroll_to_work_day = true;
                maybe_scroll_to_work_day_start();
                on_settings_loaded?.();
            }
        },
        error() {
            // The default settings work until the next try.
            settings_state = "unloaded";
        },
    });
}

export function show(location: CalendarLocation): void {
    current_location = location;
    occurrences = [];
    load_state = "loading";
    if (settings_state === "unloaded") {
        fetch_settings();
    }
    render_grid();
    should_scroll_to_work_day = true;
    fetch_events();
    now_timer = setInterval(update_now_line, 60 * 1000);
}

export function go_to_location(location: CalendarLocation): void {
    current_location = location;
    occurrences = [];
    load_state = "loading";
    const scroll_top = $("#calendar-view .calendar-grid-container").scrollTop();
    render_grid();
    $("#calendar-view .calendar-grid-container").scrollTop(scroll_top ?? 0);
    fetch_events();
}

export function hide(): void {
    clearInterval(now_timer);
    now_timer = undefined;
    current_location = undefined;
    request_id += 1;
}

// Called when one of the user's events changes; the occurrences
// depend on the range shown, so the week is fetched again.
export function refresh(): void {
    if (current_location !== undefined) {
        fetch_events();
    }
}

export function initialize({on_settings_change}: {on_settings_change: () => void}): void {
    on_settings_loaded = on_settings_change;
    $("#calendar-view").on("click", ".calendar-grid-retry", () => {
        assert(current_location !== undefined);
        go_to_location(current_location);
    });
}
