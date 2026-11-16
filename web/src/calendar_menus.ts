import {$} from "jquery";
import assert from "minimalistic-assert";
import * as tippy from "tippy.js";

import render_calendar_filter_menu_popover from "../templates/popovers/calendar/calendar_filter_menu_popover.hbs";
import render_calendar_submenu_popover from "../templates/popovers/calendar/calendar_submenu_popover.hbs";

import * as calendar_filter from "./calendar_filter.ts";
import * as calendar_grid from "./calendar_grid.ts";
import {$t} from "./i18n.ts";
import * as popover_menus from "./popover_menus.ts";
import * as ui_util from "./ui_util.ts";

// The menus of the calendar's toolbar, and their submenus, which open
// to the right of their items.

type SubmenuOption = {value: string; label: string; checked: string};

type Submenu = {
    is_radio: boolean;
    get_options: () => SubmenuOption[];
    on_click: (value: string) => void;
};

let current_submenu: tippy.Instance | undefined;

export function hide_submenu(): void {
    current_submenu?.destroy();
    current_submenu = undefined;
}

function render_submenu(id: string, submenu: Submenu): string {
    return render_calendar_submenu_popover({
        id,
        is_radio: submenu.is_radio,
        options: submenu.get_options(),
    });
}

function show_submenu(trigger: HTMLElement, parent: tippy.Instance, submenu: Submenu): void {
    if (current_submenu?.reference === trigger) {
        return;
    }
    hide_submenu();
    const id = trigger.dataset["submenu"]!;
    const instance = tippy.default(trigger, {
        ...popover_menus.default_popover_props,
        theme: "popover-menu",
        placement: "right-start",
        trigger: "manual",
        hideOnClick: false,
        // Inside the menu, so that clicks in the submenu do not close it,
        // and the arrow keys move from the menu into the submenu.
        appendTo: parent.popper,
        content: ui_util.parse_html(render_submenu(id, submenu)),
    });
    $(instance.popper).on("click", ".calendar-submenu-option", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        submenu.on_click(this.dataset["value"]!);
        if (current_submenu === instance) {
            instance.setContent(ui_util.parse_html(render_submenu(id, submenu)));
        }
    });
    instance.show();
    current_submenu = instance;
}

// Opens the submenus of a menu as their items are hovered or focused.
export function setup_submenus(parent: tippy.Instance, get_submenu: (id: string) => Submenu): void {
    const $popper = $(parent.popper);
    $popper.on("mouseenter focusin", ".popover-menu-link", function (this: HTMLElement) {
        if ($(this).closest(".calendar-submenu").length > 0) {
            return;
        }
        if (this.classList.contains("calendar-submenu-trigger")) {
            show_submenu(this, parent, get_submenu(this.dataset["submenu"]!));
        } else {
            hide_submenu();
        }
    });
}

export function get_checked_state(keys: string[]): string {
    const hidden = calendar_filter.get_hidden_keys();
    const hidden_count = keys.filter((key) => hidden.has(key)).length;
    if (hidden_count === 0) {
        return "true";
    }
    return hidden_count === keys.length ? "false" : "mixed";
}

// Outlook's default color categories, by the names Exchange stores,
// with "" for events without a category.
const CATEGORIES = [
    ["Red category", "red"],
    ["Orange category", "orange"],
    ["Yellow category", "yellow"],
    ["Green category", "green"],
    ["Blue category", "blue"],
    ["Purple category", "purple"],
    ["", "none"],
] as const;

type FilterOption = {
    id: string;
    label: string;
    keys: string[];
    submenu?: {key: string; label: string}[];
};

function get_filter_options(): FilterOption[][] {
    return [
        [
            {
                id: "personal",
                label: $t({defaultMessage: "Personal events"}),
                keys: ["personal"],
            },
            {
                id: "meetings",
                label: $t({defaultMessage: "Meetings"}),
                keys: calendar_filter.MEETING_KEYS,
                submenu: calendar_filter.MEETING_KEYS.map((key) => ({
                    key,
                    label: $t(
                        {
                            defaultMessage:
                                "{role, select, organizer {I'm the organizer} accepted {Accepted} tentative {Tentative} none {Not answered} other {Following}}",
                        },
                        {role: key.split(":", 2)[1]!},
                    ),
                })),
            },
        ],
        [
            {
                id: "categories",
                label: $t({defaultMessage: "Categories"}),
                keys: CATEGORIES.map(([name]) => calendar_filter.get_category_key(name)),
                submenu: CATEGORIES.map(([name, color]) => ({
                    key: calendar_filter.get_category_key(name),
                    label: $t(
                        {
                            defaultMessage:
                                "{color, select, red {Red category} orange {Orange category} yellow {Yellow category} green {Green category} blue {Blue category} purple {Purple category} other {No category}}",
                        },
                        {color},
                    ),
                })),
            },
            {
                id: "show_as",
                label: $t({defaultMessage: "Show as"}),
                keys: calendar_filter.SHOW_AS_KEYS,
                submenu: calendar_filter.SHOW_AS_KEYS.map((key) => ({
                    key,
                    label: calendar_grid.get_free_busy_status(Number(key.split(":", 2)[1])).label,
                })),
            },
            {
                id: "recurring",
                label: $t({defaultMessage: "Recurring events"}),
                keys: ["recurring"],
            },
        ],
    ];
}

function get_filter_option(id: string): FilterOption {
    const option = get_filter_options()
        .flat()
        .find((option) => option.id === id);
    assert(option !== undefined);
    return option;
}

function render_filter_menu(): string {
    return render_calendar_filter_menu_popover({
        groups: get_filter_options().map((options) =>
            options.map((option) => ({
                id: option.id,
                label: option.label,
                checked: get_checked_state(option.keys),
                has_submenu: option.submenu !== undefined,
            })),
        ),
    });
}

function get_filter_submenu(id: string, on_change: () => void): Submenu {
    const option = get_filter_option(id);
    assert(option.submenu !== undefined);
    const submenu = option.submenu;
    return {
        is_radio: false,
        get_options: () =>
            submenu.map(({key, label}) => ({
                value: key,
                label,
                checked: get_checked_state([key]),
            })),
        on_click(key) {
            calendar_filter.set_hidden([key], get_checked_state([key]) === "true");
            on_change();
        },
    };
}

export function register_filter_menu(on_change: () => void): void {
    // The menu belongs to a wrapper of the button, since an element
    // with a tooltip cannot also open a popover.
    popover_menus.register_popover_menu("#calendar-view .calendar-filter-menu-trigger", {
        theme: "popover-menu",
        placement: "bottom-start",
        onShow(instance) {
            instance.setContent(ui_util.parse_html(render_filter_menu()));
            popover_menus.popover_instances.calendar_filter_menu = instance;
            popover_menus.on_show_prep(instance);
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            // Updates the menu where it is, keeping its open submenu.
            const update = (): void => {
                on_change();
                const $menu = $(ui_util.parse_html(render_filter_menu()));
                $popper.find(".calendar-filter-option").each(function () {
                    const id = this.dataset["filterOption"]!;
                    const $new = $menu.find(`.calendar-filter-option[data-filter-option="${id}"]`);
                    $(this).attr("aria-checked", $new.attr("aria-checked")!);
                    $(this)
                        .find(".calendar-menu-checkbox")
                        .replaceWith($new.find(".calendar-menu-checkbox"));
                });
            };
            setup_submenus(instance, (id) => get_filter_submenu(id, update));
            $popper.on("click", ".calendar-filter-option", function (this: HTMLElement, e) {
                e.preventDefault();
                const option = get_filter_option(this.dataset["filterOption"]!);
                calendar_filter.set_hidden(option.keys, get_checked_state(option.keys) === "true");
                update();
                current_submenu?.setContent(
                    ui_util.parse_html(
                        render_submenu(option.id, get_filter_submenu(option.id, update)),
                    ),
                );
            });
            $popper.on("click", ".calendar-filter-reset", (e) => {
                e.preventDefault();
                calendar_filter.reset();
                hide_submenu();
                update();
            });
        },
        onHidden(instance) {
            hide_submenu();
            instance.destroy();
            popover_menus.popover_instances.calendar_filter_menu = null;
        },
    });
}
