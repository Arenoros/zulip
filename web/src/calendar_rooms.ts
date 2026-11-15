import * as z from "zod/mini";

import render_input_pill from "../templates/input_pill.hbs";

import {Typeahead} from "./bootstrap_typeahead.ts";
import type {TypeaheadInputElement} from "./bootstrap_typeahead.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as input_pill from "./input_pill.ts";
import type {InputPillContainer} from "./input_pill.ts";
import * as typeahead from "./typeahead.ts";
import {render_typeahead_item} from "./typeahead_helper.ts";

// The meeting rooms of the organization, which meetings book.
export const room_schema = z.object({
    id: z.number(),
    name: z.string(),
    capacity: z.nullable(z.number()),
    location: z.string(),
    email: z.string(),
    is_archived: z.boolean(),
});

export type CalendarRoom = z.infer<typeof room_schema>;

export type RoomPill = {
    type: "room";
    room_id: number;
};

export type RoomPillWidget = InputPillContainer<RoomPill>;

let rooms: CalendarRoom[] | undefined;
const on_fetch_callbacks: (() => void)[] = [];

function call_fetch_callbacks(): void {
    for (const callback of on_fetch_callbacks.splice(0)) {
        callback();
    }
}

function fetch(): void {
    void channel.get({
        url: "/json/calendar/rooms",
        success(data) {
            rooms = z.object({rooms: z.array(room_schema)}).parse(data).rooms;
            call_fetch_callbacks();
        },
        // Without the rooms, what needs them still opens.
        error: call_fetch_callbacks,
    });
}

// Calls on_loaded once the rooms are known. The rooms are fetched
// again each time, which keeps those that administrators add or
// change current.
export function ensure_loaded(on_loaded: () => void = () => undefined): void {
    if (rooms === undefined) {
        on_fetch_callbacks.push(on_loaded);
    } else {
        on_loaded();
    }
    fetch();
}

export function get_rooms(): CalendarRoom[] {
    return rooms ?? [];
}

export function maybe_get_room(room_id: number): CalendarRoom | undefined {
    return rooms?.find((room) => room.id === room_id);
}

export function get_room_name(room_id: number): string {
    const room = maybe_get_room(room_id);
    if (room === undefined) {
        return $t({defaultMessage: "Unknown meeting room"});
    }
    if (room.is_archived) {
        return $t({defaultMessage: "{name} (archived)"}, {name: room.name});
    }
    return room.name;
}

export function get_room_details(room: CalendarRoom): string {
    const details = [];
    if (room.capacity !== null) {
        details.push(
            $t(
                {defaultMessage: "{capacity, plural, one {# seat} other {# seats}}"},
                {capacity: room.capacity},
            ),
        );
    }
    if (room.location !== "") {
        details.push(room.location);
    }
    return details.join(" · ");
}

// Like Outlook, the booked rooms come first in the place of a meeting.
export function get_location_label(room_ids: number[], location: string): string {
    return [...room_ids.map((room_id) => get_room_name(room_id)), location]
        .filter((part) => part !== "")
        .join("; ");
}

export function create_pills(
    $container: JQuery,
    room_ids: number[],
    is_disabled: boolean,
): RoomPillWidget {
    const pills = input_pill.create<RoomPill>({
        $container,
        // What is typed stays text, the place of the meeting.
        convert_to_pill_on_enter: false,
        split_text_on_comma: false,
        create_item_from_text: () => undefined,
        get_text_from_item: (item) => get_room_name(item.room_id),
        get_display_value_from_item: (item) => get_room_name(item.room_id),
        generate_pill_html: (item, disabled) =>
            render_input_pill({display_value: get_room_name(item.room_id), disabled}),
    });
    for (const room_id of room_ids) {
        pills.appendValidatedData({type: "room", room_id}, is_disabled, true);
    }
    if (!is_disabled) {
        set_up_typeahead(
            $container.find(".input"),
            (room_id) => {
                pills.appendValidatedData({type: "room", room_id});
            },
            () => pills.items().map((item) => item.room_id),
        );
    }
    return pills;
}

export function get_room_ids(pills: RoomPillWidget): number[] {
    return pills.items().map((item) => item.room_id);
}

export function set_up_typeahead(
    $input: JQuery,
    on_select: (room_id: number) => void,
    get_excluded_room_ids: () => number[],
): void {
    const bootstrap_typeahead_input: TypeaheadInputElement = {
        $element: $input,
        type: "contenteditable",
    };
    new Typeahead(bootstrap_typeahead_input, {
        dropup: true,
        source(_query: string): CalendarRoom[] {
            const excluded = new Set(get_excluded_room_ids());
            return get_rooms().filter((room) => !room.is_archived && !excluded.has(room.id));
        },
        item_html(_query: string): (room: CalendarRoom) => string {
            return (room: CalendarRoom) =>
                render_typeahead_item({primary: room.name, secondary: get_room_details(room)});
        },
        matcher(query: string): (room: CalendarRoom) => boolean {
            const cleaned_query = typeahead.clean_query_lowercase(query);
            return (room: CalendarRoom) =>
                typeahead
                    .remove_diacritics(`${room.name} ${room.location}`.toLowerCase())
                    .includes(typeahead.remove_diacritics(cleaned_query));
        },
        sorter(matches: CalendarRoom[]): CalendarRoom[] {
            return matches;
        },
        updater(room: CalendarRoom, _query: string): undefined {
            on_select(room.id);
            $input.trigger("focus");
        },
        stopAdvance: true,
    });
}
