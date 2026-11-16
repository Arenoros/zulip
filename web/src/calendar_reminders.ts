import {$} from "jquery";
import * as z from "zod/mini";

import * as banners from "./banners.ts";
import * as calendar_actions from "./calendar_actions.ts";
import * as calendar_call from "./calendar_call.ts";
import * as calendar_grid from "./calendar_grid.ts";
import type {CalendarOccurrence} from "./calendar_grid.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import {localstorage} from "./localstorage.ts";
import * as popup_banners from "./popup_banners.ts";

// Reminders of meetings show as banners, as incoming calls do, from
// the time of the reminder until the meeting ends, in every open
// client, until they are closed. Without an open client, there is no
// reminder.

// The longest reminder is a week before.
const LOOKAHEAD_SECONDS = 8 * 24 * 60 * 60;
const CHECK_INTERVAL_MS = 30 * 1000;
// Changes to meetings fetch them again, so this only catches up with
// the passing of time.
const FETCH_INTERVAL_MS = 60 * 60 * 1000;
const DISMISSED_KEY = "calendar_dismissed_reminders";

let occurrences: CalendarOccurrence[] = [];
const banners_by_key = new Map<string, JQuery>();
let fetch_timeout: ReturnType<typeof setTimeout> | undefined;

// A meeting moved to another time reminds again.
function get_key(occurrence: CalendarOccurrence): string {
    return `${occurrence.id}:${occurrence.original_start ?? ""}:${occurrence.start}`;
}

function get_dismissed(): string[] {
    const result = z.array(z.string()).safeParse(localstorage().get(DISMISSED_KEY));
    return result.success ? result.data : [];
}

function dismiss(occurrence: CalendarOccurrence): void {
    const now = Date.now() / 1000;
    // Reminders of meetings that are over cannot show again.
    const dismissed = get_dismissed().filter((key) => Number(key.split(":")[2]) > now);
    localstorage().set(DISMISSED_KEY, [...dismissed, get_key(occurrence)]);
    remove_banner(get_key(occurrence));
}

function remove_banner(key: string): void {
    const $banner = banners_by_key.get(key);
    if ($banner !== undefined) {
        banners_by_key.delete(key);
        popup_banners.fade_out_popup_banner($banner);
    }
}

function is_due(occurrence: CalendarOccurrence, now: number): boolean {
    return (
        occurrence.reminder_minutes !== null &&
        !occurrence.is_cancelled &&
        now >= occurrence.start - occurrence.reminder_minutes * 60 &&
        now < occurrence.end
    );
}

function get_label(occurrence: CalendarOccurrence, now: number): string {
    const minutes = Math.ceil((occurrence.start - now) / 60);
    if (minutes <= 0) {
        return $t({defaultMessage: "{title} has started."}, {title: occurrence.title});
    }
    if (minutes < 60) {
        return $t(
            {
                defaultMessage: "{title} starts in {N, plural, one {# minute} other {# minutes}}.",
            },
            {title: occurrence.title, N: minutes},
        );
    }
    return $t(
        {defaultMessage: "{title}: {time}"},
        {title: occurrence.title, time: calendar_actions.get_time_label(occurrence)},
    );
}

function show_banner(occurrence: CalendarOccurrence, now: number): JQuery {
    const $banner = banners.append(
        {
            intent: "info",
            label: get_label(occurrence, now),
            buttons: [
                ...(calendar_call.can_join(occurrence)
                    ? [
                          {
                              variant: "solid" as const,
                              intent: "brand" as const,
                              label: $t({defaultMessage: "Join"}),
                              custom_classes: "calendar-reminder-join",
                          },
                      ]
                    : []),
                {
                    variant: "subtle" as const,
                    intent: "info" as const,
                    label: $t({defaultMessage: "Close"}),
                    custom_classes: "calendar-reminder-close",
                },
            ],
            close_button: false,
            custom_classes: "calendar-reminder-banner popup-banner",
        },
        $("#popup_banners_wrapper"),
    );
    $banner.attr("data-reminder-key", get_key(occurrence));
    return $banner;
}

export function check(): void {
    const now = Date.now() / 1000;
    const dismissed = new Set(get_dismissed());
    const due_keys = new Set<string>();
    for (const occurrence of occurrences) {
        const key = get_key(occurrence);
        if (!is_due(occurrence, now) || dismissed.has(key)) {
            continue;
        }
        due_keys.add(key);
        const $banner = banners_by_key.get(key);
        if ($banner === undefined) {
            banners_by_key.set(key, show_banner(occurrence, now));
        } else {
            $banner.find(".banner-label").text(get_label(occurrence, now));
        }
    }
    for (const key of banners_by_key.keys()) {
        if (!due_keys.has(key)) {
            remove_banner(key);
        }
    }
}

export function fetch(): void {
    clearTimeout(fetch_timeout);
    fetch_timeout = setTimeout(fetch, FETCH_INTERVAL_MS);
    const now = Math.floor(Date.now() / 1000);
    void channel.get({
        url: "/json/calendar/events",
        data: {start: now, end: now + LOOKAHEAD_SECONDS},
        success(data) {
            occurrences = calendar_grid.events_schema.parse(data).events;
            check();
        },
    });
}

function find_occurrence(element: HTMLElement): CalendarOccurrence | undefined {
    const key = $(element).closest(".calendar-reminder-banner").attr("data-reminder-key");
    return occurrences.find((occurrence) => get_key(occurrence) === key);
}

export function initialize(): void {
    fetch();
    setInterval(check, CHECK_INTERVAL_MS);
    $("body").on("click", ".calendar-reminder-join", function (this: HTMLElement) {
        const occurrence = find_occurrence(this);
        if (occurrence !== undefined) {
            calendar_call.join(occurrence.id, false, $("#home-error"));
            dismiss(occurrence);
        }
    });
    $("body").on("click", ".calendar-reminder-close", function (this: HTMLElement) {
        const occurrence = find_occurrence(this);
        if (occurrence !== undefined) {
            dismiss(occurrence);
        }
    });
}
