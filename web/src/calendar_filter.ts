import * as z from "zod/mini";

import {localstorage} from "./localstorage.ts";

// The filter of the calendar, which hides some of the user's own events
// on this device. Each kind of event has a key, and the filter keeps
// the keys of the kinds it hides.

// The values of CalendarResponse on the server.
const RESPONSE_ACCEPTED = 2;
const RESPONSE_TENTATIVE = 3;
const RESPONSE_FOLLOWING = 5;

const HIDDEN_KEY = "calendar-filter-hidden";

export type FilteredEvent = {
    original_start: number | null;
    show_as: number;
    organizer_id: number;
    response: number;
    category: string;
    attendees: {user_id: number}[];
};

export const MEETING_KEYS = [
    "meetings:organizer",
    "meetings:accepted",
    "meetings:tentative",
    "meetings:none",
    "meetings:following",
];
// The values of CalendarShowAs on the server.
export const SHOW_AS_KEYS = [1, 2, 3, 4, 5].map((show_as) => `show_as:${show_as}`);

export function get_category_key(category: string): string {
    return `category:${category}`;
}

export function get_hidden_keys(): Set<string> {
    const hidden = z.array(z.string()).safeParse(localstorage().get(HIDDEN_KEY));
    return new Set(hidden.success ? hidden.data : []);
}

function set_hidden_keys(keys: Set<string>): void {
    localstorage().set(HIDDEN_KEY, [...keys].toSorted());
}

export function is_filtering(): boolean {
    return get_hidden_keys().size > 0;
}

export function set_hidden(keys: string[], is_hidden: boolean): void {
    const hidden = get_hidden_keys();
    for (const key of keys) {
        if (is_hidden) {
            hidden.add(key);
        } else {
            hidden.delete(key);
        }
    }
    set_hidden_keys(hidden);
}

export function reset(): void {
    set_hidden_keys(new Set());
}

function is_personal(event: FilteredEvent, my_user_id: number): boolean {
    return (
        event.organizer_id === my_user_id &&
        event.attendees.every((attendee) => attendee.user_id === my_user_id)
    );
}

function get_meeting_key(event: FilteredEvent, my_user_id: number): string {
    if (event.organizer_id === my_user_id) {
        return "meetings:organizer";
    }
    switch (event.response) {
        case RESPONSE_ACCEPTED:
            return "meetings:accepted";
        case RESPONSE_TENTATIVE:
            return "meetings:tentative";
        case RESPONSE_FOLLOWING:
            return "meetings:following";
        default:
            return "meetings:none";
    }
}

// The keys of the kinds an event is of; the filter hides it if it
// hides any of them.
export function get_event_keys(event: FilteredEvent, my_user_id: number): string[] {
    return [
        is_personal(event, my_user_id) ? "personal" : get_meeting_key(event, my_user_id),
        get_category_key(event.category),
        `show_as:${event.show_as}`,
        ...(event.original_start === null ? [] : ["recurring"]),
    ];
}

export function filter_events<T extends FilteredEvent>(events: T[], my_user_id: number): T[] {
    const hidden = get_hidden_keys();
    if (hidden.size === 0) {
        return events;
    }
    return events.filter((event) =>
        get_event_keys(event, my_user_id).every((key) => !hidden.has(key)),
    );
}
