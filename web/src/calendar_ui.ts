import {addMonths, addWeeks, isSameDay, isSameMonth, startOfMonth, startOfToday} from "date-fns";
import {$} from "jquery";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";
import * as z from "zod/mini";

import render_calendar_mini_month from "../templates/calendar/calendar_mini_month.hbs";
import render_calendar_view from "../templates/calendar/calendar_view.hbs";
import render_calendar_date_picker_popover from "../templates/popovers/calendar/calendar_date_picker_popover.hbs";
import render_calendar_view_menu_popover from "../templates/popovers/calendar/calendar_view_menu_popover.hbs";

import * as browser_history from "./browser_history.ts";
import * as calendar_util from "./calendar_util.ts";
import type {CalendarLocation, CalendarView} from "./calendar_util.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import {localstorage} from "./localstorage.ts";
import * as narrow_title from "./narrow_title.ts";
import * as overlay_util from "./overlay_util.ts";
import * as people from "./people.ts";
import * as popover_menus from "./popover_menus.ts";
import * as timerender from "./timerender.ts";
import * as ui_report from "./ui_report.ts";
import * as ui_util from "./ui_util.ts";
import {user_settings} from "./user_settings.ts";

const pinned_users_schema = z.object({
    pinned_users: z.array(z.object({user_id: z.number(), color: z.string()})),
});

type PinnedUser = z.infer<typeof pinned_users_schema>["pinned_users"][number];

const LEFT_PANEL_COLLAPSED_KEY = "calendar-left-panel-collapsed";

let current_location: CalendarLocation | undefined;
// The month the small calendar in the left panel shows, which its
// arrows change without changing the week.
let left_panel_month: Date | undefined;
// The hash of the chat view behind the calendar, which the calendar
// returns to.
let hash_behind_calendar: string | undefined;
let pinned_users: PinnedUser[] = [];
let unanswered_invitation_count = 0;

function today(): Date {
    return startOfToday({in: timerender.display_tz});
}

function capitalize(text: string): string {
    return text.charAt(0).toLocaleUpperCase(user_settings.default_language) + text.slice(1);
}

function format_date(date: Date, options: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(user_settings.default_language, options).format(date);
}

function get_view_label(view: CalendarView): string {
    if (view === "week") {
        return $t({defaultMessage: "Week"});
    }
    return $t({defaultMessage: "Work week"});
}

// Narrow windows show the short range, without the year, which the
// small calendar of the left panel shows.
function get_range_label(location: CalendarLocation, length: "long" | "short"): string {
    const days = calendar_util.get_shown_days(location);
    const first_day = days[0]!;
    const last_day = days.at(-1)!;
    if (length === "long") {
        return new Intl.DateTimeFormat(user_settings.default_language, {
            day: "numeric",
            month: "long",
            year: "numeric",
        }).formatRange(first_day, last_day);
    }
    const formatter = new Intl.DateTimeFormat(user_settings.default_language, {
        day: "numeric",
        month: "short",
    });
    if (first_day.getFullYear() !== last_day.getFullYear()) {
        // formatRange adds the years to a range across years.
        return `${formatter.format(first_day)} – ${formatter.format(last_day)}`;
    }
    return formatter.formatRange(first_day, last_day);
}

function get_mini_month_context(
    month: Date,
    selected_week_start: Date | undefined,
): Record<string, unknown> {
    const today_date = today();
    const weeks = calendar_util.get_month_weeks(month);
    return {
        month: calendar_util.format_date(month),
        month_label:
            capitalize(format_date(month, {month: "long"})) +
            " " +
            format_date(month, {year: "numeric"}),
        weekday_labels: weeks[0]!.map((day) => capitalize(format_date(day, {weekday: "short"}))),
        weeks: weeks.map((days) => ({
            is_selected:
                selected_week_start !== undefined && isSameDay(days[0]!, selected_week_start),
            days: days.map((day) => ({
                date: calendar_util.format_date(day),
                day_number: day.getDate(),
                label: format_date(day, {dateStyle: "full"}),
                is_today: isSameDay(day, today_date),
                is_other_month: !isSameMonth(day, month),
            })),
        })),
    };
}

function get_selected_week_start(): Date | undefined {
    if (current_location === undefined) {
        return undefined;
    }
    return calendar_util.parse_date(current_location.week_start);
}

function render_left_panel_mini_month(): void {
    assert(left_panel_month !== undefined);
    $("#calendar-view .calendar-left-panel-mini-month").html(
        render_calendar_mini_month(
            get_mini_month_context(left_panel_month, get_selected_week_start()),
        ),
    );
}

function get_pinned_users_context(): {user_id: number; color: string; full_name: string}[] {
    return pinned_users.flatMap((pinned_user) => {
        const user = people.maybe_get_user_by_id(pinned_user.user_id, true);
        if (user === undefined) {
            return [];
        }
        return [{...pinned_user, full_name: user.full_name}];
    });
}

function is_left_panel_collapsed(): boolean {
    return localstorage().get(LEFT_PANEL_COLLAPSED_KEY) === true;
}

function render_view(): void {
    assert(current_location !== undefined);
    const $view = $("#calendar-view");
    $view.toggleClass("left-panel-collapsed", is_left_panel_collapsed());
    $view.html(
        render_calendar_view({
            is_left_panel_collapsed: is_left_panel_collapsed(),
            mini_month: get_mini_month_context(left_panel_month!, get_selected_week_start()),
            pinned_users: get_pinned_users_context(),
            range_label: get_range_label(current_location, "long"),
            short_range_label: get_range_label(current_location, "short"),
            view_label: get_view_label(current_location.view),
        }),
    );
}

export function go_to_location(location: CalendarLocation): void {
    current_location = location;
    left_panel_month = startOfMonth(calendar_util.parse_date(location.week_start)!);
    // Moving between weeks replaces the URL instead of adding to the
    // browser history, so that going back leaves the calendar.
    window.history.replaceState(
        null,
        "",
        browser_history.get_full_url(calendar_util.calendar_hash(location)),
    );
    $("#calendar-view .calendar-range-label").text(get_range_label(location, "long"));
    $("#calendar-view .calendar-short-range-label").text(get_range_label(location, "short"));
    const view_label = get_view_label(location.view);
    $("#calendar-view .calendar-view-label").text(view_label);
    $("#calendar-view .calendar-view-button").attr({
        "aria-label": view_label,
        "data-tippy-content": view_label,
    });
    render_left_panel_mini_month();
}

function go_to_date(date: Date): void {
    assert(current_location !== undefined);
    go_to_location(calendar_util.get_location_for_date(current_location.view, date));
}

function move_by_weeks(weeks: number): void {
    assert(current_location !== undefined);
    go_to_date(addWeeks(calendar_util.parse_date(current_location.week_start)!, weeks));
}

function fetch_pinned_users(): void {
    void channel.get({
        url: "/json/calendar/pinned_users",
        success(raw_data) {
            pinned_users = pinned_users_schema.parse(raw_data).pinned_users;
            if (calendar_util.is_visible()) {
                render_view();
            }
        },
        error(xhr) {
            ui_report.error(
                $t({defaultMessage: "Failed to load your colleagues' calendars"}),
                xhr,
                $("#home-error"),
            );
        },
    });
}

export function get_location_from_hash(hash: string): CalendarLocation | undefined {
    return calendar_util.parse_calendar_hash(hash, today());
}

export function show(location: CalendarLocation, hash_of_view_behind: string): void {
    assert(!calendar_util.is_visible());
    hash_behind_calendar = hash_of_view_behind;
    calendar_util.set_visible(true);
    $("body").addClass("calendar-view-visible");
    overlay_util.disable_scrolling();
    $("#calendar-navbar-button").attr("aria-pressed", "true");
    narrow_title.redraw_title();
    current_location = location;
    left_panel_month = startOfMonth(calendar_util.parse_date(location.week_start)!);
    render_view();
    fetch_pinned_users();
    go_to_location(location);
}

export function hide(): void {
    if (!calendar_util.is_visible()) {
        return;
    }
    popover_menus.hide_current_popover_if_visible(popover_menus.popover_instances.calendar_view_menu);
    popover_menus.hide_current_popover_if_visible(
        popover_menus.popover_instances.calendar_date_picker,
    );
    calendar_util.set_visible(false);
    $("body").removeClass("calendar-view-visible");
    $("#calendar-view").empty();
    $("#calendar-navbar-button").attr("aria-pressed", "false");
    narrow_title.redraw_title();
    overlay_util.enable_scrolling();
    current_location = undefined;
}

export function is_hash_behind_calendar(hash: string): boolean {
    return calendar_util.is_visible() && hash === hash_behind_calendar;
}

export function return_to_chat(): void {
    assert(hash_behind_calendar !== undefined);
    // The chat view behind the calendar is still rendered, so we only
    // restore its URL.
    browser_history.update(hash_behind_calendar);
    hide();
}

function render_unanswered_invitation_count(): void {
    const $count = $("#calendar-navbar-button .calendar-navbar-count");
    $count.text(unanswered_invitation_count > 99 ? "99+" : unanswered_invitation_count);
    $count.toggleClass("hide", unanswered_invitation_count === 0);
    $("#calendar-navbar-button").attr(
        "aria-label",
        unanswered_invitation_count === 0
            ? $t({defaultMessage: "Calendar"})
            : $t(
                  {
                      defaultMessage:
                          "Calendar, {count, plural, one {# unanswered invitation} other {# unanswered invitations}}",
                  },
                  {count: unanswered_invitation_count},
              ),
    );
}

export function update_unanswered_invitation_count(count: number): void {
    unanswered_invitation_count = count;
    render_unanswered_invitation_count();
}

function register_view_menu_popover(): void {
    // The menu belongs to a wrapper of the button, since an element
    // with a tooltip cannot also open a popover.
    popover_menus.register_popover_menu("#calendar-view .calendar-view-menu-trigger", {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            assert(current_location !== undefined);
            const current_view = current_location.view;
            const views: CalendarView[] = ["workweek", "week"];
            instance.setContent(
                ui_util.parse_html(
                    render_calendar_view_menu_popover({
                        views: views.map((view) => ({
                            view,
                            label: get_view_label(view),
                            is_current: view === current_view,
                        })),
                    }),
                ),
            );
            popover_menus.popover_instances.calendar_view_menu = instance;
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            $(instance.popper).on("click", ".calendar-view-option", function (this: HTMLElement) {
                assert(current_location !== undefined);
                const view = this.dataset["calendarView"] === "week" ? "week" : "workweek";
                go_to_location({...current_location, view});
                popover_menus.hide_current_popover_if_visible(instance);
            });
        },
        onHidden(instance) {
            instance.destroy();
            popover_menus.popover_instances.calendar_view_menu = null;
        },
    });
}

function render_date_picker(instance: tippy.Instance, month: Date): void {
    instance.setContent(
        ui_util.parse_html(
            render_calendar_date_picker_popover(
                get_mini_month_context(month, get_selected_week_start()),
            ),
        ),
    );
}

function get_mini_month($element: JQuery): Date {
    const month = $element.closest(".calendar-mini-month").attr("data-month");
    assert(month !== undefined);
    return calendar_util.parse_date(month)!;
}

function register_date_picker_popover(): void {
    popover_menus.register_popover_menu("#calendar-view .calendar-range-button", {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            render_date_picker(instance, left_panel_month!);
            popover_menus.popover_instances.calendar_date_picker = instance;
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            $popper.on("click", ".calendar-mini-month-previous", function (this: HTMLElement) {
                render_date_picker(instance, addMonths(get_mini_month($(this)), -1));
            });
            $popper.on("click", ".calendar-mini-month-next", function (this: HTMLElement) {
                render_date_picker(instance, addMonths(get_mini_month($(this)), 1));
            });
            $popper.on("click", ".calendar-mini-month-day", function (this: HTMLElement) {
                go_to_date(calendar_util.parse_date(this.dataset["date"]!)!);
                popover_menus.hide_current_popover_if_visible(instance);
            });
        },
        onHidden(instance) {
            instance.destroy();
            popover_menus.popover_instances.calendar_date_picker = null;
        },
    });
}

export function initialize({
    unanswered_invitation_count: initial_count,
}: {
    unanswered_invitation_count: number;
}): void {
    update_unanswered_invitation_count(initial_count);

    $("body").on("click", "#calendar-navbar-button", (e) => {
        e.preventDefault();
        if (calendar_util.is_visible()) {
            return_to_chat();
        } else {
            browser_history.go_to_location("#calendar");
        }
    });

    const $view = $("#calendar-view");
    $view.on("click", ".calendar-toggle-left-panel", () => {
        localstorage().set(LEFT_PANEL_COLLAPSED_KEY, !is_left_panel_collapsed());
        render_view();
    });
    $view.on("click", ".calendar-today-button", () => {
        go_to_date(today());
    });
    $view.on("click", ".calendar-previous-week", () => {
        move_by_weeks(-1);
    });
    $view.on("click", ".calendar-next-week", () => {
        move_by_weeks(1);
    });
    $view.on("click", ".calendar-left-panel .calendar-mini-month-previous", () => {
        left_panel_month = addMonths(left_panel_month!, -1);
        render_left_panel_mini_month();
    });
    $view.on("click", ".calendar-left-panel .calendar-mini-month-next", () => {
        left_panel_month = addMonths(left_panel_month!, 1);
        render_left_panel_mini_month();
    });
    $view.on("click", ".calendar-left-panel .calendar-mini-month-day", function (this: HTMLElement) {
        const date = calendar_util.parse_date(this.dataset["date"]!)!;
        go_to_date(date);
    });

    register_view_menu_popover();
    register_date_picker_popover();
}

