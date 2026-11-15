import * as z from "zod/mini";

import * as channel from "./channel.ts";
import {localstorage} from "./localstorage.ts";
import * as people from "./people.ts";

// The colleagues whose calendars the user pinned next to their own,
// which the server keeps with their colors, and which of them the
// calendar shows, which each device keeps.

// The colors of colleagues' calendars, for the light and dark themes.
// The server keeps the light one.
const PALETTE = [
    {light: "#2f6fc4", dark: "#4d94e8"},
    {light: "#1e8a45", dark: "#3fbf6b"},
    {light: "#c25e00", dark: "#f0883e"},
    {light: "#c4314b", dark: "#f1707b"},
    {light: "#b4009e", dark: "#e05bd0"},
    {light: "#8f6b00", dark: "#e0b43a"},
];

// Lists longer than this show their first colleagues until "Show all".
export const COLLAPSED_LIST_LENGTH = 5;

const SHOWN_KEY = "calendar-shown-colleagues";
const SIDE_BY_SIDE_KEY = "calendar-side-by-side";

const pinned_users_schema = z.object({
    pinned_users: z.array(z.object({user_id: z.number(), color: z.string()})),
});

type PinnedUser = z.infer<typeof pinned_users_schema>["pinned_users"][number];

export type Colleague = {
    user_id: number;
    full_name: string;
    // A CSS color for both themes.
    color: string;
    is_shown: boolean;
};

let pinned_users: PinnedUser[] = [];
let on_change: (() => void) | undefined;

export function get_theme_color(color: string): string {
    const pair = PALETTE.find((colors) => colors.light === color);
    return pair === undefined ? color : `light-dark(${pair.light}, ${pair.dark})`;
}

// The first color of the palette that no pinned colleague has, or
// else the colors in turn.
export function get_next_color(colors: string[]): string {
    const unused = PALETTE.find((pair) => !colors.includes(pair.light));
    return (unused ?? PALETTE[colors.length % PALETTE.length]!).light;
}

function get_shown_ids(): number[] {
    const shown = z.array(z.number()).safeParse(localstorage().get(SHOWN_KEY));
    return shown.success ? shown.data : [];
}

function set_shown_ids(user_ids: number[]): void {
    localstorage().set(SHOWN_KEY, user_ids);
}

export function get_colleagues(): Colleague[] {
    const shown_ids = new Set(get_shown_ids());
    return pinned_users.flatMap((pinned_user) => {
        const user = people.maybe_get_user_by_id(pinned_user.user_id, true);
        if (user === undefined || !people.is_active_user(user.user_id)) {
            return [];
        }
        return [
            {
                user_id: user.user_id,
                full_name: user.full_name,
                color: get_theme_color(pinned_user.color),
                is_shown: shown_ids.has(user.user_id),
            },
        ];
    });
}

// Whether the calendars of the checked colleagues are shown; the view
// menu hides them all without unchecking them.
export function is_side_by_side_enabled(): boolean {
    return localstorage().get(SIDE_BY_SIDE_KEY) !== false;
}

export function set_side_by_side_enabled(is_enabled: boolean): void {
    localstorage().set(SIDE_BY_SIDE_KEY, is_enabled);
    on_change?.();
}

export function get_shown_colleagues(): Colleague[] {
    if (!is_side_by_side_enabled()) {
        return [];
    }
    return get_colleagues().filter((colleague) => colleague.is_shown);
}

export function is_pinned(user_id: number): boolean {
    return pinned_users.some((pinned_user) => pinned_user.user_id === user_id);
}

export function set_shown(user_id: number, is_shown: boolean): void {
    const shown_ids = get_shown_ids().filter((id) => id !== user_id);
    set_shown_ids(is_shown ? [...shown_ids, user_id] : shown_ids);
    on_change?.();
}

export function pin(user_id: number, on_error: (xhr: JQuery.jqXHR) => void): void {
    const color = get_next_color(pinned_users.map((pinned_user) => pinned_user.color));
    void channel.post({
        url: "/json/calendar/pinned_users",
        data: {user_id: JSON.stringify(user_id), color},
        success() {
            pinned_users = [...pinned_users, {user_id, color}];
            set_shown(user_id, true);
        },
        error: on_error,
    });
}

export function unpin(user_id: number, on_error: (xhr: JQuery.jqXHR) => void): void {
    void channel.del({
        url: `/json/calendar/pinned_users/${user_id}`,
        success() {
            pinned_users = pinned_users.filter((pinned_user) => pinned_user.user_id !== user_id);
            set_shown(user_id, false);
        },
        error: on_error,
    });
}

export function fetch(on_error: (xhr: JQuery.jqXHR) => void): void {
    void channel.get({
        url: "/json/calendar/pinned_users",
        success(raw_data) {
            pinned_users = pinned_users_schema.parse(raw_data).pinned_users;
            on_change?.();
        },
        error: on_error,
    });
}

export function initialize({on_colleagues_change}: {on_colleagues_change: () => void}): void {
    on_change = on_colleagues_change;
}
