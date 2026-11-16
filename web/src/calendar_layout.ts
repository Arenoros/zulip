import {TZDate} from "@date-fns/tz";
import {addDays, format} from "date-fns";

// Where the events of a week go on the calendar's grid: events with
// a time in the columns of their days, all-day events and events of a
// day or more in the row above them.

export type LayoutEvent = {
    // In seconds since the epoch.
    start: number;
    end: number;
    is_all_day: boolean;
    // The timezone the event was scheduled in, whose dates an all-day
    // event spans.
    timezone: string;
};

export type TimedEventPlacement<T> = {
    event: T;
    // Minutes after the day's midnight by the clock, so that the hours
    // of the grid stay put on days when daylight saving time changes.
    start_minute: number;
    end_minute: number;
    // Overlapping events share their day's width: the event is in
    // `column` of `column_count` equal columns.
    column: number;
    column_count: number;
    // Whether the event goes on from the day before or into the next.
    continues_before: boolean;
    continues_after: boolean;
};

export type AllDayEventPlacement<T> = {
    event: T;
    // Indexes of the shown days the event covers.
    first_day: number;
    last_day: number;
    // The row of the all-day area the event is in.
    lane: number;
};

export type WeekLayout<T> = {
    days: TimedEventPlacement<T>[][];
    all_day: AllDayEventPlacement<T>[];
    all_day_lane_count: number;
};

const MINUTES_PER_DAY = 24 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;
const DATE_FORMAT = "yyyy-MM-dd";

function to_date_string(seconds: number, time_zone: string): string {
    return format(new TZDate(seconds * 1000, time_zone), DATE_FORMAT);
}

// The start of a day, or of the day after it, in seconds.
export function get_day_start(date_string: string, time_zone: string, day_offset = 0): number {
    const [year, month, day] = date_string.split("-").map(Number);
    return new TZDate(year!, month! - 1, day! + day_offset, time_zone).getTime() / 1000;
}

function get_minute_of_day(seconds: number, time_zone: string): number {
    const date = new TZDate(seconds * 1000, time_zone);
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function is_all_day_row_event(event: LayoutEvent): boolean {
    return event.is_all_day || event.end - event.start >= SECONDS_PER_DAY;
}

export type WorkHours = {
    // The timezone of the work hours, or "" for that of the calendar.
    timezone: string;
    // ISO days of the week, 1 for Monday.
    work_days: number[];
    work_day_start_minutes: number;
    work_day_end_minutes: number;
};

// The parts of the day that are outside of someone's work hours, in
// minutes after midnight by the clock of the calendar's timezone, like
// the events of the day. Work hours in another timezone may begin on
// the day before or after.
export function get_off_hours(
    date_string: string,
    time_zone: string,
    hours: WorkHours,
): {start_minute: number; end_minute: number}[] {
    const day_start = get_day_start(date_string, time_zone);
    const day_end = get_day_start(date_string, time_zone, 1);
    const work_time_zone = hours.timezone || time_zone;
    const get_minute = (seconds: number): number => {
        if (seconds <= day_start) {
            return 0;
        }
        if (seconds >= day_end) {
            return MINUTES_PER_DAY;
        }
        return get_minute_of_day(seconds, time_zone);
    };
    const off_hours = [];
    let worked_until = 0;
    for (const day_offset of [-1, 0, 1]) {
        const work_day_start = get_day_start(date_string, work_time_zone, day_offset);
        const weekday = new TZDate(work_day_start * 1000, work_time_zone).getDay() || 7;
        if (!hours.work_days.includes(weekday)) {
            continue;
        }
        const start = get_minute(work_day_start + hours.work_day_start_minutes * 60);
        const end = get_minute(work_day_start + hours.work_day_end_minutes * 60);
        if (start >= end) {
            continue;
        }
        if (start > worked_until) {
            off_hours.push({start_minute: worked_until, end_minute: start});
        }
        worked_until = Math.max(worked_until, end);
    }
    if (worked_until < MINUTES_PER_DAY) {
        off_hours.push({start_minute: worked_until, end_minute: MINUTES_PER_DAY});
    }
    return off_hours;
}

// The dates an event in the all-day area covers, the last one
// included.
function get_all_day_dates(event: LayoutEvent, time_zone: string): [string, string] {
    if (event.is_all_day) {
        // All-day events are midnight to midnight in their own
        // timezone, and cover the same dates everywhere.
        const first = to_date_string(event.start, event.timezone);
        const end = new TZDate(event.end * 1000, event.timezone);
        return [first, format(addDays(end, -1), DATE_FORMAT)];
    }
    return [to_date_string(event.start, time_zone), to_date_string(event.end - 1, time_zone)];
}

// Assigns overlapping events to columns, the first that is free, and
// gives each group of events that overlap one another, directly or
// through other events, the number of columns it needs.
function place_in_columns<T>(
    events: Omit<TimedEventPlacement<T>, "column" | "column_count">[],
    min_minutes: number,
): TimedEventPlacement<T>[] {
    const sorted = events.toSorted(
        (a, b) => a.start_minute - b.start_minute || b.end_minute - a.end_minute,
    );
    // An event is never drawn shorter than min_minutes, so it
    // overlaps whatever starts before it is drawn to end.
    const shown_end = (event: (typeof sorted)[number]): number =>
        Math.max(event.end_minute, event.start_minute + min_minutes);

    const placements: TimedEventPlacement<T>[] = [];
    let group: TimedEventPlacement<T>[] = [];
    let column_ends: number[] = [];
    let group_end = -Infinity;

    const close_group = (): void => {
        for (const placement of group) {
            placement.column_count = column_ends.length;
        }
        placements.push(...group);
        group = [];
        column_ends = [];
    };

    for (const event of sorted) {
        if (event.start_minute >= group_end) {
            close_group();
        }
        let column = column_ends.findIndex((column_end) => column_end <= event.start_minute);
        if (column === -1) {
            column = column_ends.length;
            column_ends.push(0);
        }
        column_ends[column] = shown_end(event);
        group_end = Math.max(group_end, shown_end(event));
        group.push({...event, column, column_count: 0});
    }
    close_group();
    return placements;
}

export function get_week_layout<T extends LayoutEvent>(
    events: T[],
    // The shown days, as "yyyy-MM-dd", in order.
    days: string[],
    time_zone: string,
    // The shortest duration an event is drawn with.
    min_minutes: number,
): WeekLayout<T> {
    const day_starts = days.map((day) => get_day_start(day, time_zone));
    const day_ends = days.map((day) => get_day_start(day, time_zone, 1));

    const timed: Omit<TimedEventPlacement<T>, "column" | "column_count">[][] = days.map(() => []);
    const all_day: Omit<AllDayEventPlacement<T>, "lane">[] = [];

    for (const event of events) {
        if (is_all_day_row_event(event)) {
            const [first_date, last_date] = get_all_day_dates(event, time_zone);
            const first_day = days.findIndex((day) => day >= first_date);
            const last_day = days.findLastIndex((day) => day <= last_date);
            if (first_day !== -1 && last_day !== -1 && first_day <= last_day) {
                all_day.push({event, first_day, last_day});
            }
            continue;
        }
        for (const [index, day_start] of day_starts.entries()) {
            const day_end = day_ends[index]!;
            // Events of no duration show on the day they are at.
            const overlaps =
                event.start < day_end &&
                (event.end > day_start || (event.end === event.start && event.start >= day_start));
            if (!overlaps) {
                continue;
            }
            const continues_before = event.start < day_start;
            const continues_after = event.end > day_end;
            timed[index]!.push({
                event,
                start_minute: continues_before ? 0 : get_minute_of_day(event.start, time_zone),
                end_minute:
                    continues_after || event.end === day_end
                        ? MINUTES_PER_DAY
                        : get_minute_of_day(event.end, time_zone),
                continues_before,
                continues_after,
            });
        }
    }

    // Longer events take the upper lanes, as in Outlook.
    const lane_ends: number[] = [];
    const all_day_placements = all_day
        .toSorted(
            (a, b) =>
                a.first_day - b.first_day || b.last_day - b.first_day - (a.last_day - a.first_day),
        )
        .map((placement) => {
            let lane = lane_ends.findIndex((lane_end) => lane_end < placement.first_day);
            if (lane === -1) {
                lane = lane_ends.length;
                lane_ends.push(0);
            }
            lane_ends[lane] = placement.last_day;
            return {...placement, lane};
        });

    return {
        days: timed.map((day_events) => place_in_columns(day_events, min_minutes)),
        all_day: all_day_placements,
        all_day_lane_count: lane_ends.length,
    };
}
