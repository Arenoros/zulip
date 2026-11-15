import {$} from "jquery";

import render_calendar_settings_form from "../templates/settings/calendar_settings_form.hbs";

import * as calendar_form from "./calendar_form.ts";
import * as calendar_grid from "./calendar_grid.ts";
import * as calendar_ui from "./calendar_ui.ts";
import * as calendar_util from "./calendar_util.ts";
import * as channel from "./channel.ts";
import {$t} from "./i18n.ts";
import * as settings_ui from "./settings_ui.ts";
import {user_settings} from "./user_settings.ts";

// The calendar section of the personal settings, which are saved as
// soon as they change.

const MINUTES_PER_DAY = 24 * 60;
const WORK_HOURS_STEP_MINUTES = 30;

function get_weekday_label(iso_weekday: number): string {
    // January 1, 2024 was a Monday.
    const date = new Date(Date.UTC(2024, 0, iso_weekday));
    return calendar_util.capitalize(
        new Intl.DateTimeFormat(user_settings.default_language, {
            weekday: "long",
            timeZone: "UTC",
        }).format(date),
        user_settings.default_language,
    );
}

function get_time_label(minutes: number): string {
    if (minutes === MINUTES_PER_DAY) {
        return $t({defaultMessage: "Midnight"});
    }
    return calendar_form.format_minutes(minutes);
}

function get_context(): Record<string, unknown> {
    const settings = calendar_grid.get_settings();
    const steps = Array.from(
        {length: MINUTES_PER_DAY / WORK_HOURS_STEP_MINUTES + 1},
        (_, index) => index * WORK_HOURS_STEP_MINUTES,
    );
    const time_options = (selected: number, minutes: number[]): Record<string, unknown>[] =>
        minutes.map((value) => ({value, label: get_time_label(value), selected: value === selected}));
    return {
        work_days: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
            day,
            label: get_weekday_label(day),
            is_work_day: settings.work_days.includes(day),
        })),
        work_day_start_options: time_options(settings.work_day_start_minutes, steps.slice(0, -1)),
        work_day_end_options: time_options(settings.work_day_end_minutes, steps.slice(1)),
        view_options: (["workweek", "week"] as const).map((view) => ({
            value: view,
            label: calendar_ui.get_view_label(view),
            selected: view === calendar_grid.get_default_view(),
        })),
        time_scale_options: calendar_ui.TIME_SCALES.map((minutes) => ({
            value: minutes,
            label: calendar_ui.get_time_scale_label(minutes),
            selected: minutes === settings.time_scale_minutes,
        })),
        reminder_options: calendar_form.REMINDERS.map((minutes) => ({
            value: minutes === null ? "" : minutes,
            label: calendar_form.get_reminder_label(minutes),
            selected: minutes === settings.default_reminder_minutes,
        })),
    };
}

function render(): void {
    $("#calendar-settings").html(render_calendar_settings_form(get_context()));
}

// The settings changed, maybe in another client; the fields show them
// without losing the status of the last change.
export function update(): void {
    const $section = $("#calendar-settings");
    if ($section.children().length === 0) {
        return;
    }
    const settings = calendar_grid.get_settings();
    $section.find<HTMLInputElement>(".calendar-settings-work-day-checkbox").each(function () {
        this.checked = settings.work_days.includes(Number(this.value));
    });
    $section.find("#calendar_work_day_start_minutes").val(String(settings.work_day_start_minutes));
    $section.find("#calendar_work_day_end_minutes").val(String(settings.work_day_end_minutes));
    $section.find("#calendar_default_view").val(calendar_grid.get_default_view());
    $section.find("#calendar_time_scale_minutes").val(String(settings.time_scale_minutes));
    $section
        .find("#calendar_default_reminder_minutes")
        .val(settings.default_reminder_minutes === null ? "" : String(settings.default_reminder_minutes));
}

function get_change_data(element: HTMLElement): Record<string, string> {
    const $section = $("#calendar-settings");
    if (element.classList.contains("calendar-settings-work-day-checkbox")) {
        const work_days = $section
            .find<HTMLInputElement>(".calendar-settings-work-day-checkbox:checked")
            .toArray()
            .map((checkbox) => Number(checkbox.value));
        return {work_days: JSON.stringify(work_days)};
    }
    const value = $(element).val()!;
    switch (element.id) {
        case "calendar_default_view":
            return {default_view: JSON.stringify(value === "week" ? 1 : 2)};
        case "calendar_default_reminder_minutes":
            return {default_reminder_minutes: JSON.stringify(value === "" ? null : Number(value))};
        default:
            return {[element.id.replace(/^calendar_/, "")]: JSON.stringify(Number(value))};
    }
}

export function set_up(): void {
    render();
    $("#calendar-settings")
        .off("change")
        .on("change", "input, select", function (this: HTMLElement) {
            const $status = $(this).closest(".subsection-parent").find(".alert-notification");
            settings_ui.do_settings_change(
                channel.patch,
                "/json/calendar/settings",
                get_change_data(this),
                $status,
                {
                    // An invalid change, such as no work days, is undone.
                    error_continuation: update,
                },
            );
        });
}
