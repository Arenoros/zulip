import {addDays, format, isValid, parse, startOfMonth, startOfWeek} from "date-fns";

export type CalendarView = "week" | "workweek";

export type CalendarLocation = {
    view: CalendarView;
    // The Monday of the week shown, as "yyyy-MM-dd".
    week_start: string;
};

const DATE_FORMAT = "yyyy-MM-dd";
const CALENDAR_VIEWS = new Set<string>(["week", "workweek"]);
// Weeks always start on Monday, like the ISO weekdays of the
// calendar settings.
const WEEK_OPTIONS = {weekStartsOn: 1} as const;
const DEFAULT_VIEW: CalendarView = "workweek";

let is_calendar_visible = false;

export function is_visible(): boolean {
    return is_calendar_visible;
}

export function set_visible(value: boolean): void {
    is_calendar_visible = value;
}

export function parse_date(date_string: string): Date | undefined {
    const date = parse(date_string, DATE_FORMAT, new Date(0));
    if (!isValid(date) || format(date, DATE_FORMAT) !== date_string) {
        return undefined;
    }
    return date;
}

export function format_date(date: Date): string {
    return format(date, DATE_FORMAT);
}

export function get_week_start(date: Date): Date {
    return startOfWeek(date, WEEK_OPTIONS);
}

export function get_location_for_date(view: CalendarView, date: Date): CalendarLocation {
    return {view, week_start: format_date(get_week_start(date))};
}

export function is_calendar_hash(hash: string | undefined): boolean {
    return hash === "#calendar" || (hash?.startsWith("#calendar/") ?? false);
}

// Returns the location in a #calendar hash, with the week containing
// `today` when the hash names no date, or undefined if the hash is
// invalid.
export function parse_calendar_hash(hash: string, today: Date): CalendarLocation | undefined {
    const [category, view, date_string, ...rest] = hash.replace(/\/$/, "").split("/");
    if (category !== "#calendar" || rest.length > 0) {
        return undefined;
    }
    if (view === undefined) {
        return get_location_for_date(DEFAULT_VIEW, today);
    }
    if (!CALENDAR_VIEWS.has(view)) {
        return undefined;
    }
    const calendar_view = view === "week" ? "week" : "workweek";
    if (date_string === undefined) {
        return get_location_for_date(calendar_view, today);
    }
    const date = parse_date(date_string);
    if (date === undefined) {
        return undefined;
    }
    return get_location_for_date(calendar_view, date);
}

export function calendar_hash(location: CalendarLocation): string {
    return `#calendar/${location.view}/${location.week_start}`;
}

// The days a location shows: the whole week, or the user's work days,
// as ISO weekdays, Monday being 1.
export function get_shown_days(location: CalendarLocation, work_days: number[]): Date[] {
    const week_start = parse_date(location.week_start)!;
    const days = Array.from({length: 7}, (_, index) => addDays(week_start, index));
    if (location.view === "week") {
        return days;
    }
    return days.filter((_day, index) => work_days.includes(index + 1));
}

// The weeks of a small month calendar, from the week containing the
// first day of the month. It always has six weeks, the most a month
// can span, so that its height does not change between months.
export function get_month_weeks(month: Date): Date[][] {
    const first_week_start = get_week_start(startOfMonth(month));
    return Array.from({length: 6}, (_, week_index) =>
        Array.from({length: 7}, (_, day_index) =>
            addDays(first_week_start, week_index * 7 + day_index),
        ),
    );
}

// Rounds minutes to the nearest step. Small negative values round to
// 0, not to -0.
export function snap_minutes(minutes: number, step: number): number {
    return Math.round(minutes / step) * step || 0;
}

// Names of months and weekdays start with a capital letter in the
// calendar, also in languages like Russian that write them in lower
// case.
export function capitalize(text: string, language: string): string {
    return text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
}
