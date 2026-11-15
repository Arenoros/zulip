import {TZDate} from "@date-fns/tz";
import {addMonths, addWeeks, format, getISODay, isSameMonth, startOfMonth} from "date-fns";
import {$} from "jquery";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";

import render_calendar_mini_month from "../templates/calendar/calendar_mini_month.hbs";
import render_calendar_pinned_users from "../templates/calendar/calendar_pinned_users.hbs";
import render_calendar_view from "../templates/calendar/calendar_view.hbs";
import render_calendar_card_choices_popover from "../templates/popovers/calendar/calendar_card_choices_popover.hbs";
import render_calendar_date_picker_popover from "../templates/popovers/calendar/calendar_date_picker_popover.hbs";
import render_calendar_view_menu_popover from "../templates/popovers/calendar/calendar_view_menu_popover.hbs";

import * as browser_history from "./browser_history.ts";
import * as calendar_actions from "./calendar_actions.ts";
import * as calendar_call from "./calendar_call.ts";
import * as calendar_card from "./calendar_card.ts";
import * as calendar_colleagues from "./calendar_colleagues.ts";
import * as calendar_filter from "./calendar_filter.ts";
import * as calendar_form from "./calendar_form.ts";
import * as calendar_grid from "./calendar_grid.ts";
import * as calendar_meeting from "./calendar_meeting.ts";
import * as calendar_menus from "./calendar_menus.ts";
import * as calendar_responses from "./calendar_responses.ts";
import * as calendar_util from "./calendar_util.ts";
import type {CalendarLocation, CalendarView} from "./calendar_util.ts";
import * as channel from "./channel.ts";
import * as compose_call from "./compose_call.ts";
import * as dropdown_widget from "./dropdown_widget.ts";
import {$t} from "./i18n.ts";
import {localstorage} from "./localstorage.ts";
import * as narrow_title from "./narrow_title.ts";
import * as overlay_util from "./overlay_util.ts";
import * as people from "./people.ts";
import * as popover_menus from "./popover_menus.ts";
import * as ui_report from "./ui_report.ts";
import * as ui_util from "./ui_util.ts";
import {user_settings} from "./user_settings.ts";

const LEFT_PANEL_COLLAPSED_KEY = "calendar-left-panel-collapsed";

let current_location: CalendarLocation | undefined;
// The month the small calendar in the left panel shows, which its
// arrows change without changing the week.
let left_panel_month: Date | undefined;
// The hash of the chat view behind the calendar, which the calendar
// returns to.
let hash_behind_calendar: string | undefined;
// Whether the list of colleagues shows all of them.
let is_colleague_list_expanded = false;
let unanswered_invitation_count = 0;

function today(): Date {
    return calendar_util.parse_date(calendar_grid.get_today())!;
}

function format_date(date: Date, options: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(user_settings.default_language, options).format(date);
}

export const TIME_SCALES = [15, 30, 60];

export function get_time_scale_label(minutes: number): string {
    return $t({defaultMessage: "{minutes} minutes"}, {minutes});
}

export function get_view_label(view: CalendarView): string {
    if (view === "week") {
        return $t({defaultMessage: "Week"});
    }
    return $t({defaultMessage: "Work week"});
}

// Narrow windows show the short range, without the year, which the
// small calendar of the left panel shows.
function get_range_label(location: CalendarLocation, length: "long" | "short"): string {
    const days = calendar_util.get_shown_days(location, calendar_grid.get_work_days());
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

function get_mini_month_context(month: Date): Record<string, unknown> {
    const today_date = calendar_grid.get_today();
    const weeks = calendar_util.get_month_weeks(month);
    return {
        month: calendar_util.format_date(month),
        month_label:
            calendar_util.capitalize(
                format_date(month, {month: "long"}),
                user_settings.default_language,
            ) +
            " " +
            format_date(month, {year: "numeric"}),
        weekday_labels: weeks[0]!.map((day) =>
            calendar_util.capitalize(
                format_date(day, {weekday: "short"}),
                user_settings.default_language,
            ),
        ),
        weeks: weeks.map((days) => ({
            is_selected: calendar_util.format_date(days[0]!) === current_location?.week_start,
            days: days.map((day) => ({
                date: calendar_util.format_date(day),
                day_number: day.getDate(),
                label: format_date(day, {dateStyle: "full"}),
                is_today: calendar_util.format_date(day) === today_date,
                is_other_month: !isSameMonth(day, month),
            })),
        })),
    };
}

function render_left_panel_mini_month(): void {
    assert(left_panel_month !== undefined);
    $("#calendar-view .calendar-left-panel-mini-month").html(
        render_calendar_mini_month(get_mini_month_context(left_panel_month)),
    );
}

function get_colleague_list_context(): Record<string, unknown> {
    const colleagues = calendar_colleagues.get_colleagues();
    return {
        colleagues: colleagues.map((colleague, index) => ({
            ...colleague,
            is_hidden_in_list:
                !is_colleague_list_expanded &&
                index >= calendar_colleagues.COLLAPSED_LIST_LENGTH,
        })),
        has_more: colleagues.length > calendar_colleagues.COLLAPSED_LIST_LENGTH,
        is_expanded: is_colleague_list_expanded,
    };
}

function render_colleague_list(): void {
    $("#calendar-view .calendar-colleagues").html(
        render_calendar_pinned_users(get_colleague_list_context()),
    );
}

function is_side_by_side(): boolean {
    return calendar_colleagues.get_shown_colleagues().length > 0;
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
            mini_month: get_mini_month_context(left_panel_month!),
            colleague_list: get_colleague_list_context(),
            is_filtering: calendar_filter.is_filtering(),
            legend: calendar_grid.get_legend(),
            range_label: get_range_label(current_location, "long"),
            short_range_label: get_range_label(current_location, "short"),
            view_label: get_view_label(current_location.view),
            can_meet_now: compose_call.is_livekit_call_provider(),
        }),
    );
}

function toggle_left_panel(): void {
    const is_collapsed = !is_left_panel_collapsed();
    localstorage().set(LEFT_PANEL_COLLAPSED_KEY, is_collapsed);
    $("#calendar-view").toggleClass("left-panel-collapsed", is_collapsed);
    const label = is_collapsed
        ? $t({defaultMessage: "Show calendar panel"})
        : $t({defaultMessage: "Hide calendar panel"});
    $("#calendar-view .calendar-toggle-left-panel").attr({
        "aria-label": label,
        "data-tippy-content": label,
        "aria-expanded": String(!is_collapsed),
    });
}

function update_toolbar(location: CalendarLocation): void {
    $("#calendar-view .calendar-range-label").text(get_range_label(location, "long"));
    $("#calendar-view .calendar-short-range-label").text(get_range_label(location, "short"));
    const view_label = is_side_by_side()
        ? $t(
              {defaultMessage: "{view} · side by side"},
              {view: get_view_label(location.view)},
          )
        : get_view_label(location.view);
    $("#calendar-view .calendar-view-label").text(view_label);
    $("#calendar-view .calendar-view-button").attr({
        "aria-label": view_label,
        "data-tippy-content": view_label,
    });
}

function replace_url(location: CalendarLocation): void {
    // Moving between weeks replaces the URL instead of adding to the
    // browser history, so that going back leaves the calendar.
    window.history.replaceState(
        null,
        "",
        browser_history.get_full_url(calendar_util.calendar_hash(location)),
    );
}

export function go_to_location(location: CalendarLocation): void {
    current_location = location;
    left_panel_month = startOfMonth(calendar_util.parse_date(location.week_start)!);
    replace_url(location);
    update_toolbar(location);
    render_left_panel_mini_month();
    calendar_grid.go_to_location(location);
}

function go_to_date(date: Date): void {
    assert(current_location !== undefined);
    go_to_location(calendar_util.get_location_for_date(current_location.view, date));
}

function move_by_weeks(weeks: number): void {
    assert(current_location !== undefined);
    go_to_date(addWeeks(calendar_util.parse_date(current_location.week_start)!, weeks));
}

function report_error(message: string): (xhr: JQuery.jqXHR) => void {
    return (xhr) => {
        ui_report.error(message, xhr, $("#home-error"));
    };
}

function on_colleagues_change(): void {
    if (!calendar_util.is_visible()) {
        return;
    }
    assert(current_location !== undefined);
    render_colleague_list();
    $("#calendar-view").toggleClass("side-by-side", is_side_by_side());
    update_toolbar(current_location);
    calendar_grid.set_colleagues(calendar_colleagues.get_shown_colleagues());
}

function setup_add_colleague_widget(): void {
    new dropdown_widget.DropdownWidget({
        widget_name: "calendar-add-colleague",
        get_options: () =>
            people
                .get_realm_active_human_users()
                .filter(
                    (user) =>
                        !people.is_my_user_id(user.user_id) &&
                        !calendar_colleagues.is_pinned(user.user_id),
                )
                .map((user) => ({unique_id: user.user_id, name: user.full_name})),
        item_click_callback(event, instance) {
            event.preventDefault();
            event.stopPropagation();
            instance.hide();
            calendar_colleagues.pin(
                Number($(event.currentTarget).attr("data-unique-id")),
                report_error($t({defaultMessage: "Failed to add the calendar"})),
            );
        },
        $events_container: $("#calendar-view .calendar-left-panel"),
        unique_id_type: "number",
        search_placeholder_text: $t({defaultMessage: "Find a colleague"}),
        tippy_props: {placement: "bottom-start"},
    }).setup();
}

export function get_location_from_hash(hash: string): CalendarLocation | undefined {
    return calendar_util.parse_calendar_hash(hash, today(), calendar_grid.get_default_view());
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
    replace_url(location);
    $("#calendar-view").toggleClass("side-by-side", is_side_by_side());
    render_view();
    setup_add_colleague_widget();
    calendar_grid.show(location, calendar_colleagues.get_shown_colleagues());
    calendar_form.restore();
    calendar_meeting.restore();
    calendar_colleagues.fetch(
        report_error($t({defaultMessage: "Failed to load your colleagues' calendars"})),
    );
}

// Shows the week of the occurrence, and opens it: as the organizer,
// to change it next to the responses, as an attendee, to answer it.
// The week is all that shows of an occurrence no longer in the user's
// calendar, such as one they declined.
export function open_event_link(
    link: calendar_util.CalendarEventLink,
    hash_of_view_behind: string,
): void {
    const date = calendar_util.parse_date(
        format(new TZDate(link.start * 1000, calendar_grid.get_time_zone()), "yyyy-MM-dd"),
    )!;
    // The work week shows the occurrence only on a work day.
    const iso_weekday = getISODay(date);
    const view =
        calendar_grid.get_work_days().includes(iso_weekday) && current_location?.view !== "week"
            ? "workweek"
            : "week";
    const location = calendar_util.get_location_for_date(view, date);
    if (calendar_util.is_visible()) {
        go_to_location(location);
    } else {
        show(location, hash_of_view_behind);
    }
    void channel.get({
        url: "/json/calendar/events",
        data: {start: link.start, end: link.start + 1},
        success(data) {
            const occurrence = calendar_grid.events_schema
                .parse(data)
                .events.find(
                    (occurrence) =>
                        occurrence.id === link.event_id && occurrence.start === link.start,
                );
            if (occurrence === undefined || !calendar_util.is_visible()) {
                return;
            }
            if (occurrence.organizer_id === people.my_current_user_id()) {
                calendar_form.open_edit(
                    occurrence,
                    occurrence.original_start !== null,
                    !calendar_actions.is_personal(occurrence),
                );
            } else {
                calendar_meeting.open(occurrence);
            }
        },
        error: report_error($t({defaultMessage: "Failed to open the event"})),
    });
}

export function hide(): void {
    if (!calendar_util.is_visible()) {
        return;
    }
    popover_menus.hide_current_popover_if_visible(popover_menus.popover_instances.calendar_view_menu);
    popover_menus.hide_current_popover_if_visible(
        popover_menus.popover_instances.calendar_date_picker,
    );
    calendar_form.save_draft();
    calendar_grid.hide();
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
                        is_side_by_side: calendar_colleagues.is_side_by_side_enabled(),
                        time_scale_label: get_time_scale_label(calendar_grid.get_time_scale()),
                    }),
                ),
            );
            popover_menus.popover_instances.calendar_view_menu = instance;
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            $popper.on("click", ".calendar-view-option", function (this: HTMLElement) {
                assert(current_location !== undefined);
                const view = this.dataset["calendarView"] === "week" ? "week" : "workweek";
                go_to_location({...current_location, view});
                calendar_grid.set_default_view(
                    view,
                    report_error($t({defaultMessage: "Failed to save the view"})),
                );
                popover_menus.hide_current_popover_if_visible(instance);
            });
            $popper.on("click", ".calendar-settings-option", () => {
                popover_menus.hide_current_popover_if_visible(instance);
                browser_history.go_to_location("#settings/calendar");
            });
            $popper.on("click", ".calendar-side-by-side-option", () => {
                calendar_colleagues.set_side_by_side_enabled(
                    !calendar_colleagues.is_side_by_side_enabled(),
                );
                popover_menus.hide_current_popover_if_visible(instance);
            });
            calendar_menus.setup_submenus(instance, () => ({
                is_radio: true,
                get_options: () =>
                    TIME_SCALES.map((minutes) => ({
                        value: String(minutes),
                        label: get_time_scale_label(minutes),
                        checked: String(minutes === calendar_grid.get_time_scale()),
                    })),
                on_click(value) {
                    calendar_grid.set_time_scale(
                        Number(value),
                        report_error($t({defaultMessage: "Failed to save the time scale"})),
                    );
                    $popper
                        .find(".calendar-menu-value")
                        .text(get_time_scale_label(Number(value)));
                },
            }));
        },
        onHidden(instance) {
            calendar_menus.hide_submenu();
            instance.destroy();
            popover_menus.popover_instances.calendar_view_menu = null;
        },
    });
}

function render_date_picker(instance: tippy.Instance, month: Date): void {
    instance.setContent(
        ui_util.parse_html(
            render_calendar_date_picker_popover(get_mini_month_context(month)),
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
        toggle_left_panel();
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
    $view.on("change", ".calendar-colleague-checkbox", function (this: HTMLInputElement) {
        calendar_colleagues.set_shown(Number(this.dataset["userId"]), this.checked);
    });
    $view.on("click", ".calendar-colleague-remove", function (this: HTMLElement) {
        calendar_colleagues.unpin(
            Number(this.dataset["userId"]),
            report_error($t({defaultMessage: "Failed to remove the calendar"})),
        );
    });
    $view.on("click", ".calendar-show-all-button", () => {
        is_colleague_list_expanded = !is_colleague_list_expanded;
        render_colleague_list();
    });

    calendar_colleagues.initialize({on_colleagues_change});
    calendar_card.initialize();
    calendar_responses.initialize();
    calendar_meeting.initialize({
        on_close() {
            $("#calendar-view .calendar-new-event-button").trigger("focus");
        },
    });
    calendar_form.initialize({
        on_close() {
            $("#calendar-view .calendar-new-event-button").trigger("focus");
        },
        get_mini_month_context,
    });
    $view.on("click", ".calendar-new-event-button", () => {
        calendar_form.open_now();
    });
    $view.on("click", ".calendar-meet-now-button", () => {
        calendar_call.show_meet_now_dialog();
    });
    // The menu belongs to a wrapper of the button, since an element
    // with a tooltip cannot also open a popover.
    $view.on("click", ".calendar-new-menu-trigger", function (this: HTMLElement) {
        popover_menus.toggle_popover_menu(this, {
            theme: "popover-menu",
            placement: "bottom-end",
            onShow(instance) {
                instance.setContent(
                    ui_util.parse_html(
                        render_calendar_card_choices_popover({
                            choices: [{value: "event", label: $t({defaultMessage: "Event"})}],
                        }),
                    ),
                );
                popover_menus.on_show_prep(instance);
            },
            onMount(instance) {
                $(instance.popper).on("click", ".calendar-card-choice", (e) => {
                    e.preventDefault();
                    popover_menus.hide_current_popover_if_visible(instance);
                    calendar_form.open_now();
                });
            },
            onHidden(instance) {
                instance.destroy();
            },
        });
    });
    $view.on("click", ".calendar-day-column", function (this: HTMLElement, e) {
        if ($(e.target).closest(".calendar-event").length > 0) {
            return;
        }
        // A new event of half an hour at the place clicked.
        const minute =
            Math.floor(
                ((e.clientY - this.getBoundingClientRect().top) /
                    this.getBoundingClientRect().height) *
                    48,
            ) * 30;
        calendar_form.open_new(this.dataset["date"]!, Math.min(Math.max(minute, 0), 23 * 60 + 30));
    });
    calendar_menus.register_filter_menu(() => {
        calendar_grid.redraw_events();
        $("#calendar-view .calendar-filter-button").toggleClass(
            "active",
            calendar_filter.is_filtering(),
        );
    });
    calendar_grid.initialize({
        // The work days in the user's settings change the work week.
        on_settings_change() {
            assert(current_location !== undefined);
            update_toolbar(current_location);
        },
    });
}

