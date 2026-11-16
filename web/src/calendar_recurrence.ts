import {TZDate} from "@date-fns/tz";
import {addDays, addMonths, addWeeks, addYears, startOfISOWeek} from "date-fns";

import * as calendar_util from "./calendar_util.ts";
import {$t} from "./i18n.ts";
import {user_settings} from "./user_settings.ts";
import * as util from "./util.ts";

// The repetition rules the calendar offers, which are those the server
// accepts: every N days, weeks on some weekdays, months on the start's
// day of the month, or years on the start's date, until a date or
// forever.

export const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

// In the order of the week the calendar shows, from Monday.
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const MAX_INTERVAL = 99;

export type Recurrence = {
    frequency: Frequency;
    interval: number;
    // Only for weekly repetitions.
    weekdays: Weekday[];
    // The last day of the series, as yyyy-MM-dd in the event's
    // timezone, or undefined for a series that repeats forever.
    until: string | undefined;
};

function is_frequency(value: string): value is Frequency {
    return FREQUENCIES.some((frequency) => frequency === value);
}

function is_weekday(value: string): value is Weekday {
    return WEEKDAYS.some((weekday) => weekday === value);
}

// The weekday of a yyyy-MM-dd date.
export function get_weekday(date: string): Weekday {
    // getDay counts from Sunday.
    return WEEKDAYS[(calendar_util.parse_date(date)!.getDay() + 6) % 7]!;
}

export function get_default_recurrence(date: string): Recurrence {
    return {frequency: "WEEKLY", interval: 1, weekdays: [get_weekday(date)], until: undefined};
}

// Reads a rule the calendar offers, or returns undefined for any other.
export function parse_rrule(rrule: string, time_zone: string): Recurrence | undefined {
    const parts = new Map<string, string>();
    for (const part of rrule.split(";")) {
        const [key, value] = part.split("=", 2);
        if (key === undefined || value === undefined) {
            return undefined;
        }
        parts.set(key, value);
    }
    const frequency = parts.get("FREQ");
    if (frequency === undefined || !is_frequency(frequency)) {
        return undefined;
    }
    const interval = Number(parts.get("INTERVAL") ?? "1");
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
        return undefined;
    }
    const weekdays = parts.get("BYDAY")?.split(",") ?? [];
    if (weekdays.some((weekday) => !is_weekday(weekday))) {
        return undefined;
    }
    let until: string | undefined;
    const until_value = parts.get("UNTIL");
    if (until_value !== undefined) {
        const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(until_value);
        if (match === null) {
            return undefined;
        }
        const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
        until = calendar_util.format_date(
            new TZDate(Date.UTC(year!, month! - 1, day, hour, minute, second), time_zone),
        );
    }
    return {
        frequency,
        interval,
        weekdays: WEEKDAYS.filter((weekday) => weekdays.includes(weekday)),
        until,
    };
}

function format_utc(date: Date): string {
    return new Date(date)
        .toISOString()
        .replaceAll(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

export function format_rrule(recurrence: Recurrence, time_zone: string): string {
    const parts = [`FREQ=${recurrence.frequency}`];
    if (recurrence.interval !== 1) {
        parts.push(`INTERVAL=${recurrence.interval}`);
    }
    if (recurrence.frequency === "WEEKLY" && recurrence.weekdays.length > 0) {
        parts.push(`BYDAY=${recurrence.weekdays.join(",")}`);
    }
    if (recurrence.until !== undefined) {
        // The series ends with the last day, wherever in the day its
        // occurrences start.
        const [year, month, day] = recurrence.until.split("-").map(Number);
        parts.push(
            `UNTIL=${format_utc(new TZDate(year!, month! - 1, day!, 23, 59, 59, time_zone))}`,
        );
    }
    return parts.join(";");
}

// A weekly series starts on its first weekday on or after the date it
// was given, as in Outlook.
export function get_first_date(recurrence: Recurrence, date: string): string {
    if (recurrence.frequency !== "WEEKLY" || recurrence.weekdays.length === 0) {
        return date;
    }
    let first_date = date;
    while (!recurrence.weekdays.includes(get_weekday(first_date))) {
        first_date = calendar_util.format_date(addDays(calendar_util.parse_date(first_date)!, 1));
    }
    return first_date;
}

function get_step_dates(recurrence: Recurrence, first: Date, step: number): Date[] {
    const count = step * recurrence.interval;
    switch (recurrence.frequency) {
        case "DAILY":
            return [addDays(first, count)];
        case "WEEKLY": {
            const week_start = addWeeks(startOfISOWeek(first), count);
            const weekdays =
                recurrence.weekdays.length > 0
                    ? recurrence.weekdays
                    : [get_weekday(calendar_util.format_date(first))];
            return weekdays
                .map((weekday) => addDays(week_start, WEEKDAYS.indexOf(weekday)))
                .filter((day) => day >= first);
        }
        // Like the server, months and years without the first date's
        // day are skipped.
        case "MONTHLY": {
            const day = addMonths(first, count);
            return day.getDate() === first.getDate() ? [day] : [];
        }
        default: {
            recurrence.frequency satisfies "YEARLY";
            const day = addYears(first, count);
            return day.getDate() === first.getDate() ? [day] : [];
        }
    }
}

// The dates of the series' first occurrences, at most max_count of
// them within max_days of its first date.
export function get_occurrence_dates(
    recurrence: Recurrence,
    date: string,
    max_count: number,
    max_days: number,
): string[] {
    const first = calendar_util.parse_date(get_first_date(recurrence, date))!;
    let last = addDays(first, max_days - 1);
    if (recurrence.until !== undefined) {
        const until = calendar_util.parse_date(recurrence.until)!;
        if (until < last) {
            last = until;
        }
    }
    const dates: string[] = [];
    for (let step = 0; ; step += 1) {
        for (const day of get_step_dates(recurrence, first, step)) {
            if (day > last || dates.length === max_count) {
                return dates;
            }
            dates.push(calendar_util.format_date(day));
        }
    }
}

export function get_weekday_name(weekday: Weekday, style: "short" | "long"): string {
    // January 1, 2024 was a Monday.
    return new Intl.DateTimeFormat(user_settings.default_language, {weekday: style}).format(
        new Date(2024, 0, 1 + WEEKDAYS.indexOf(weekday)),
    );
}

// How often the series repeats, as in "every Thursday".
export function describe_pattern(recurrence: Recurrence, date: string): string {
    const count = recurrence.interval;
    switch (recurrence.frequency) {
        case "DAILY":
            return $t(
                {defaultMessage: "{count, plural, =1 {every day} other {every # days}}"},
                {count},
            );
        case "WEEKLY": {
            const weekdays =
                recurrence.weekdays.length > 0 ? recurrence.weekdays : [get_weekday(date)];
            if (count === 1 && weekdays.length === 1) {
                return $t(
                    {
                        defaultMessage:
                            "{weekday, select, MO {every Monday} TU {every Tuesday} WE {every Wednesday} TH {every Thursday} FR {every Friday} SA {every Saturday} other {every Sunday}}",
                    },
                    {weekday: weekdays[0]!},
                );
            }
            return $t(
                {
                    defaultMessage:
                        "{count, plural, =1 {every week} other {every # weeks}} on {weekdays}",
                },
                {
                    count,
                    weekdays: util.format_array_as_list_with_conjunction(
                        weekdays.map((weekday) => get_weekday_name(weekday, "short")),
                        "long",
                    ),
                },
            );
        }
        case "MONTHLY":
            return $t(
                {
                    defaultMessage:
                        "{count, plural, =1 {every month} other {every # months}} on day {day}",
                },
                {count, day: calendar_util.parse_date(date)!.getDate()},
            );
        default:
            recurrence.frequency satisfies "YEARLY";
            return $t(
                {
                    defaultMessage:
                        "{count, plural, =1 {every year} other {every # years}} on {date}",
                },
                {
                    count,
                    date: new Intl.DateTimeFormat(user_settings.default_language, {
                        day: "numeric",
                        month: "long",
                    }).format(calendar_util.parse_date(date)),
                },
            );
    }
}

// A date in the middle of a sentence, as in "Thu 11/12/2026".
export function format_date_in_sentence(date: string): string {
    const day = calendar_util.parse_date(date)!;
    const weekday = new Intl.DateTimeFormat(user_settings.default_language, {
        weekday: "short",
    }).format(day);
    const numeric = new Intl.DateTimeFormat(user_settings.default_language, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(day);
    return `${weekday} ${numeric}`;
}

// The whole series in words, as in "Repeats every Thursday, from 10:00
// to 10:30, from Thu 11/12/2026 until Thu 5/6/2027".
export function describe(
    recurrence: Recurrence,
    date: string,
    time_range: {start: string; end: string} | undefined,
): string {
    const first_date = get_first_date(recurrence, date);
    const pattern = describe_pattern(recurrence, first_date);
    const first = format_date_in_sentence(first_date);
    if (recurrence.until === undefined) {
        if (time_range === undefined) {
            return $t({defaultMessage: "Repeats {pattern}, starting {first}"}, {pattern, first});
        }
        return $t(
            {defaultMessage: "Repeats {pattern}, from {start} to {end}, starting {first}"},
            {pattern, first, ...time_range},
        );
    }
    const last = format_date_in_sentence(recurrence.until);
    if (time_range === undefined) {
        return $t(
            {defaultMessage: "Repeats {pattern}, from {first} until {last}"},
            {pattern, first, last},
        );
    }
    return $t(
        {defaultMessage: "Repeats {pattern}, from {start} to {end}, from {first} until {last}"},
        {pattern, first, last, ...time_range},
    );
}
