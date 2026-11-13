import {$} from "jquery";
import assert from "minimalistic-assert";
import * as tippy from "tippy.js";

import render_compose_plus_menu_popover from "../templates/popovers/compose_plus_menu_popover.hbs";

import * as compose_setup from "./compose_setup.ts";
import * as compose_state from "./compose_state.ts";
import * as gif_picker_ui from "./gif_picker_ui.ts";
import * as gif_state from "./gif_state.ts";
import * as popover_menus from "./popover_menus.ts";
import * as saved_snippets_ui from "./saved_snippets_ui.ts";
import {parse_html} from "./ui_util.ts";

// The menu of the "+" button of the compose box of a single
// conversation, with what does not fit in its row: polls, to-do lists,
// global times, saved snippets and GIFs. The pickers open from an
// anchor over the "+" button, since the menu closes first.
export function initialize(): void {
    tippy.delegate("body", {
        ...popover_menus.default_popover_props,
        theme: "popover-menu",
        target: ".compose-plus-menu-button",
        placement: "top-end",
        onShow(instance) {
            instance.setContent(
                parse_html(
                    render_compose_plus_menu_popover({
                        has_content: compose_state.has_message_content(),
                        gif_enabled:
                            gif_state.is_tenor_enabled() ||
                            gif_state.is_klipy_enabled() ||
                            gif_state.is_giphy_enabled(),
                    }),
                ),
            );
            $(instance.reference)
                .attr("aria-expanded", "true")
                .addClass("compose-row-button-active");
            popover_menus.popover_instances.compose_plus_menu = instance;
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            const anchor = $(instance.reference)
                .siblings(".compose-plus-menu-picker-anchor")
                .get(0);
            assert(anchor !== undefined);
            const run = (action: () => void) => (e: JQuery.ClickEvent) => {
                e.preventDefault();
                e.stopPropagation();
                popover_menus.hide_current_popover_if_visible(instance);
                action();
            };
            $popper.one(
                "click",
                ".compose-plus-menu-poll:not(.compose-plus-menu-item-disabled)",
                run(compose_setup.open_add_poll_modal),
            );
            $popper.one(
                "click",
                ".compose-plus-menu-todo-list:not(.compose-plus-menu-item-disabled)",
                run(compose_setup.open_add_todo_list_modal),
            );
            $popper.one(
                "click",
                ".compose-plus-menu-global-time",
                run(() => {
                    compose_setup.toggle_global_time_picker(anchor);
                }),
            );
            $popper.one(
                "click",
                ".compose-plus-menu-saved-snippets",
                run(saved_snippets_ui.open_saved_snippets_dropdown_from_compose_plus_menu),
            );
            $popper.one(
                "click",
                ".compose-plus-menu-gif",
                run(() => {
                    gif_picker_ui.toggle_gif_picker(anchor);
                }),
            );
        },
        onHidden(instance) {
            $(instance.reference)
                .attr("aria-expanded", "false")
                .removeClass("compose-row-button-active");
            instance.destroy();
            popover_menus.popover_instances.compose_plus_menu = null;
        },
    });
}
