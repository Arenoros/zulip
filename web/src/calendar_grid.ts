import {TZDate} from "@date-fns/tz";
import {format} from "date-fns";
import {$} from "jquery";
import assert from "minimalistic-assert";
import * as z from "zod/mini";

import render_calendar_all_day_events from "../templates/calendar/calendar_all_day_events.hbs";
import render_calendar_day_events from "../templates/calendar/calendar_day_events.hbs";
import render_calendar_grid from "../templates/calendar/calendar_grid.hbs";
import render_calendar_grid_error from "../templates/calendar/calendar_grid_error.hbs";

import * as calendar_colleagues from "./calendar_colleagues.ts";
import type {Colleague} from "./calendar_colleagues.ts";
import * as calendar_filter from "./calendar_filter.ts";
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
const SHOW_AS_BUSY = 3;
const SHOW_AS_OOF = 4;
const SHOW_AS_WORKING_ELSEWHERE = 5;

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
        default_reminder_minutes: z.nullable(z.number()),
        time_scale_minutes: z.number(),
    }),
});

type CalendarSettings = z.infer<typeof settings_schema>["settings"];

export const occurrence_schema = z.object({
    id: z.number(),
    original_start: z.nullable(z.number()),
    start: z.number(),
    end: z.number(),
    timezone: z.string(),
    is_all_day: z.boolean(),
    title: z.string(),
    location: z.string(),
    description: z.string(),
    show_as: z.number(),
    is_private: z.boolean(),
    is_cancelled: z.boolean(),
    response: z.number(),
    organizer_id: z.number(),
    reminder_minutes: z.nullable(z.number()),
    category: z.string(),
    response_requested: z.boolean(),
    allow_forwarding: z.boolean(),
    hide_attendees: z.boolean(),
    has_zulip_call: z.boolean(),
    attendees: z.array(
        z.object({user_id: z.number(), response: z.number(), is_required: z.boolean()}),
    ),
});

export type CalendarOccurrence = z.infer<typeof occurrence_schema>;

const events_schema = z.object({events: z.array(occurrence_schema)});

const free_busy_block_schema = z.object({
    start: z.number(),
    end: z.number(),
    show_as: z.number(),
    // Only for events the user is invited to and may see.
    title: z.nullable(z.string()),
});

type FreeBusyBlock = z.infer<typeof free_busy_block_schema> & {
    is_all_day: false;
    timezone: string;
};

const free_busy_schema = z.object({
    free_busy: z.record(z.string(), z.array(free_busy_block_schema)),
});

type LoadState = "loading" | "loaded" | "error";

let settings: CalendarSettings = {
    work_days: [1, 2, 3, 4, 5],
    work_day_start_minutes: 9 * 60,
    work_day_end_minutes: 18 * 60,
    default_reminder_minutes: 15,
    time_scale_minutes: 30,
};
let settings_state: "unloaded" | "loading" | "loaded" = "unloaded";
let on_settings_loaded: (() => void) | undefined;

let current_location: CalendarLocation | undefined;
let occurrences: CalendarOccurrence[] = [];
let events_state: LoadState = "loading";
// The colleagues whose calendars are shown next to the user's own,
// and when they are busy.
let colleagues: Colleague[] = [];
let free_busy = new Map<number, FreeBusyBlock[]>();
let free_busy_state: LoadState = "loaded";
// Responses to requests for a week that is no longer shown are
// dropped.
let events_request_id = 0;
let free_busy_request_id = 0;
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

// One of the user's occurrences shown, by the attributes of its
// element in the grid.
export function get_occurrence(
    event_id: number,
    original_start: number | null,
): CalendarOccurrence | undefined {
    return occurrences.find(
        (occurrence) =>
            occurrence.id === event_id && occurrence.original_start === original_start,
    );
}

export function get_default_reminder(): number | null {
    return settings.default_reminder_minutes;
}

export function get_time_scale(): number {
    return settings.time_scale_minutes;
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

function get_load_state(): LoadState {
    if (events_state === "error" || free_busy_state === "error") {
        return "error";
    }
    if (events_state === "loading" || free_busy_state === "loading") {
        return "loading";
    }
    return "loaded";
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

function get_event_class_names(occurrence: CalendarOccurrence): string {
    return [
        is_personal_event(occurrence) ? "personal" : "meeting",
        occurrence.is_cancelled && "cancelled",
        occurrence.show_as === SHOW_AS_TENTATIVE && "tentative",
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
    // Being busy goes without saying for the user's own events.
    const status =
        occurrence.show_as === SHOW_AS_BUSY
            ? undefined
            : get_free_busy_status(occurrence.show_as).label;
    return {
        has_card: true,
        event_id: occurrence.id,
        original_start: occurrence.original_start ?? "",
        title,
        organizer_name: organizer?.full_name,
        class_names: get_event_class_names(occurrence),
        is_recurring: occurrence.original_start !== null,
        category_color: CATEGORY_COLORS.get(occurrence.category),
        label: [title, time, organizer?.full_name, status].filter(Boolean).join(", "),
    };
}

const SHOW_AS_CLASS_NAMES = new Map([
    [SHOW_AS_FREE, "free"],
    [SHOW_AS_TENTATIVE, "tentative"],
    [SHOW_AS_BUSY, "busy"],
    [SHOW_AS_OOF, "away"],
    [SHOW_AS_WORKING_ELSEWHERE, "elsewhere"],
]);

// How a user shows during an event. One message names all of these,
// since words like "Busy" are translated differently for statuses
// elsewhere in Zulip.
export function get_free_busy_status(show_as: number): {class_name: string; label: string} {
    const class_name = SHOW_AS_CLASS_NAMES.get(show_as);
    assert(class_name !== undefined);
    return {
        class_name,
        label: $t(
            {
                defaultMessage:
                    "{show_as, select, free {Free} tentative {Tentative} busy {Busy} away {Away} other {Working elsewhere}}",
            },
            {show_as: class_name},
        ),
    };
}

export function get_legend(): {class_name: string; label: string}[] {
    return [...SHOW_AS_CLASS_NAMES.keys()].map((show_as) => get_free_busy_status(show_as));
}

function get_free_busy_context(block: FreeBusyBlock): Record<string, unknown> {
    const status = get_free_busy_status(block.show_as);
    const title = block.title ?? status.label;
    const time = `${format_time(block.start)} – ${format_time(block.end)}`;
    return {
        title,
        class_names: `free-busy ${status.class_name}`,
        label: [title, time, block.title === null ? undefined : status.label]
            .filter(Boolean)
            .join(", "),
    };
}

type CalendarItem = CalendarOccurrence | FreeBusyBlock;

function get_item_context(item: CalendarItem): Record<string, unknown> {
    return "id" in item ? get_event_context(item) : get_free_busy_context(item);
}

function get_timed_item_context(
    placement: TimedEventPlacement<CalendarItem>,
): Record<string, unknown> {
    const percent = (minutes: number): number => (minutes / MINUTES_PER_DAY) * 100;
    const min_minutes = settings.time_scale_minutes * MIN_EVENT_ROWS;
    const height = Math.max(placement.end_minute - placement.start_minute, min_minutes);
    const context = get_item_context(placement.event);
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

function get_all_day_item_context(
    placement: AllDayEventPlacement<CalendarItem>,
    first_column: number,
): Record<string, unknown> {
    return {
        ...get_item_context(placement.event),
        grid_column_start: first_column + placement.first_day + 1,
        grid_column_end: first_column + placement.last_day + 2,
        grid_row: placement.lane + 1,
    };
}

// The items of each calendar shown: the user's own events first, then
// when each colleague is busy.
function get_calendar_items(): CalendarItem[][] {
    if (get_load_state() !== "loaded") {
        return [[], ...colleagues.map(() => [])];
    }
    return [
        calendar_filter.filter_events(occurrences, current_user.user_id),
        ...colleagues.map((colleague) => free_busy.get(colleague.user_id) ?? []),
    ];
}

function render_events(): void {
    const dates = get_shown_dates();
    const $grid = $("#calendar-view .calendar-grid");
    const $columns = $grid.find(".calendar-day-column");
    const all_day_events: Record<string, unknown>[] = [];
    let has_all_day_events = false;
    for (const [calendar_index, items] of get_calendar_items().entries()) {
        const layout = calendar_layout.get_week_layout(
            items,
            dates,
            get_time_zone(),
            settings.time_scale_minutes * MIN_EVENT_ROWS,
        );
        for (const [day_index, placements] of layout.days.entries()) {
            $columns
                .eq(calendar_index * dates.length + day_index)
                .find(".calendar-day-events")
                .html(
                    render_calendar_day_events({
                        events: placements.map((placement) => get_timed_item_context(placement)),
                    }),
                );
        }
        all_day_events.push(
            ...layout.all_day.map((placement) =>
                get_all_day_item_context(placement, calendar_index * dates.length),
            ),
        );
        has_all_day_events ||= layout.all_day_lane_count > 0;
    }
    $grid.find(".calendar-all-day-events").html(
        render_calendar_all_day_events({events: all_day_events}),
    );
    const load_state = get_load_state();
    $grid.toggleClass("has-all-day-events", has_all_day_events);
    // Events that come into view, from the keyboard for instance, are
    // not left under the day headers, which stay at the top.
    const top = $grid.find(".calendar-grid-top").get(0);
    $("#calendar-view .calendar-grid-container").css(
        "scroll-padding-top",
        `${top?.offsetHeight ?? 0}px`,
    );
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
    const day_count = get_shown_dates().length;
    $("#calendar-view .calendar-grid-container").html(
        render_calendar_grid({
            day_count,
            column_count: day_count * (colleagues.length + 1),
            is_side_by_side: colleagues.length > 0,
            calendars: [
                {name: $t({defaultMessage: "My calendar"}), is_mine: true},
                ...colleagues.map((colleague) => ({
                    name: colleague.full_name,
                    user_id: colleague.user_id,
                    color: colleague.color,
                })),
            ],
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
    if (should_scroll_to_work_day && get_load_state() !== "loading") {
        should_scroll_to_work_day = false;
        scroll_to_work_day_start();
    }
}

// The week shown, in seconds.
function get_week_range(): {start: number; end: number} {
    assert(current_location !== undefined);
    const dates = calendar_util
        .get_shown_days({...current_location, view: "week"}, settings.work_days)
        .map((day) => calendar_util.format_date(day));
    const time_zone = get_time_zone();
    return {
        start: calendar_layout.get_day_start(dates[0]!, time_zone),
        end: calendar_layout.get_day_start(dates.at(-1)!, time_zone, 1),
    };
}

function on_loaded(): void {
    if (calendar_util.is_visible()) {
        render_events();
        maybe_scroll_to_work_day_start();
    }
}

function fetch_events(): void {
    events_state = "loading";
    events_request_id += 1;
    const request_id = events_request_id;
    void channel.get({
        url: "/json/calendar/events",
        data: get_week_range(),
        success(raw_data) {
            if (request_id === events_request_id) {
                occurrences = events_schema.parse(raw_data).events;
                events_state = "loaded";
                on_loaded();
            }
        },
        error() {
            if (request_id === events_request_id) {
                events_state = "error";
                on_loaded();
            }
        },
    });
}

function fetch_free_busy(): void {
    free_busy_request_id += 1;
    if (colleagues.length === 0) {
        free_busy_state = "loaded";
        return;
    }
    free_busy_state = "loading";
    const request_id = free_busy_request_id;
    const user_ids = colleagues.map((colleague) => colleague.user_id);
    void channel.get({
        url: "/json/calendar/free_busy",
        data: {user_ids: JSON.stringify(user_ids), ...get_week_range()},
        success(raw_data) {
            if (request_id !== free_busy_request_id) {
                return;
            }
            const time_zone = get_time_zone();
            free_busy = new Map(
                Object.entries(free_busy_schema.parse(raw_data).free_busy).map(
                    ([user_id, blocks]) => [
                        Number(user_id),
                        blocks.map((block) => ({
                            ...block,
                            is_all_day: false,
                            timezone: time_zone,
                        })),
                    ],
                ),
            );
            free_busy_state = "loaded";
            on_loaded();
        },
        error() {
            if (request_id === free_busy_request_id) {
                free_busy_state = "error";
                on_loaded();
            }
        },
    });
}

function fetch_week(): void {
    fetch_events();
    fetch_free_busy();
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

export function show(location: CalendarLocation, shown_colleagues: Colleague[]): void {
    current_location = location;
    colleagues = shown_colleagues;
    if (settings_state === "unloaded") {
        fetch_settings();
    }
    // The week starts loading before it is drawn, so that it is not
    // drawn as free.
    events_state = "loading";
    fetch_week();
    render_grid();
    should_scroll_to_work_day = true;
    now_timer = setInterval(update_now_line, 60 * 1000);
}

// Draws the grid again, where the user was looking.
function redraw_grid(): void {
    const $container = $("#calendar-view .calendar-grid-container");
    const scroll_top = $container.scrollTop() ?? 0;
    const scroll_left = $container.scrollLeft() ?? 0;
    render_grid();
    $container.scrollTop(scroll_top);
    $container.scrollLeft(scroll_left);
}

export function go_to_location(location: CalendarLocation): void {
    current_location = location;
    fetch_week();
    redraw_grid();
}

// Draws the events again, after the filter changed.
export function redraw_events(): void {
    if (current_location !== undefined) {
        render_events();
    }
}

export function set_time_scale(minutes: number, on_error: (xhr: JQuery.jqXHR) => void): void {
    settings = {...settings, time_scale_minutes: minutes};
    if (current_location !== undefined) {
        redraw_grid();
    }
    void channel.patch({
        url: "/json/calendar/settings",
        data: {time_scale_minutes: JSON.stringify(minutes)},
        error: on_error,
    });
}

export function set_colleagues(shown_colleagues: Colleague[]): void {
    if (JSON.stringify(shown_colleagues) === JSON.stringify(colleagues)) {
        return;
    }
    colleagues = shown_colleagues;
    if (current_location !== undefined) {
        fetch_free_busy();
        redraw_grid();
    }
}

export function hide(): void {
    clearInterval(now_timer);
    now_timer = undefined;
    current_location = undefined;
    events_request_id += 1;
    free_busy_request_id += 1;
}

// Called when one of the user's events changes; the occurrences
// depend on the range shown, so the week is fetched again.
export function refresh(): void {
    if (current_location !== undefined) {
        fetch_events();
    }
}

// Called when some users' free/busy times change.
export function refresh_free_busy(user_ids: number[]): void {
    if (
        current_location !== undefined &&
        colleagues.some((colleague) => user_ids.includes(colleague.user_id))
    ) {
        fetch_free_busy();
    }
}

export function initialize({on_settings_change}: {on_settings_change: () => void}): void {
    on_settings_loaded = on_settings_change;
    $("#calendar-view").on("click", ".calendar-grid-retry", () => {
        assert(current_location !== undefined);
        go_to_location(current_location);
    });
    $("#calendar-view").on("click", ".calendar-grid-calendar-close", function (this: HTMLElement) {
        calendar_colleagues.set_shown(Number(this.dataset["userId"]), false);
    });
}
