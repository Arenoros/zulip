import {$} from "jquery";
import * as tippy from "tippy.js";

import render_compose_plus_menu_popover from "../templates/popovers/compose_plus_menu_popover.hbs";

import * as compose_setup from "./compose_setup.ts";
import * as compose_state from "./compose_state.ts";
import * as gif_picker_ui from "./gif_picker_ui.ts";
import * as gif_state from "./gif_state.ts";
import * as message_lists from "./message_lists.ts";
import * as popover_menus from "./popover_menus.ts";
import * as rows from "./rows.ts";
import * as saved_snippets_ui from "./saved_snippets_ui.ts";
import {parse_html} from "./ui_util.ts";
import * as util from "./util.ts";

// The menu of the "+" button of the compose box of a single
// conversation, with what does not fit in its row: polls, to-do lists,
// global times, saved snippets and GIFs. In the edit form of a message,
// it has just global times and saved snippets. The pickers open from
// an anchor over the "+" button, since the menu closes first.
export function initialize(): void {
    tippy.delegate("body", {
        ...popover_menus.default_popover_props,
        theme: "popover-menu",
        target: ".compose-plus-menu-button",
        placement: "top-end",
        onShow(instance) {
            const editing = $(instance.reference).closest(".message_edit_form").length > 0;
            instance.setContent(
                parse_html(
                    render_compose_plus_menu_popover({
                        editing,
                        has_content: compose_state.has_message_content(),
                        gif_enabled:
                            !editing &&
                            (gif_state.is_tenor_enabled() ||
                                gif_state.is_klipy_enabled() ||
                                gif_state.is_giphy_enabled()),
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
            // The row of a message being edited is drawn again when the
            // message changes, so the anchors are found when an item is
            // picked.
            const $edit_row = $(instance.reference).closest(".message_row");
            const edit_message_id = $edit_row.length > 0 ? rows.id($edit_row) : undefined;
            const get_anchor = (selector: string): HTMLElement => {
                const $container =
                    edit_message_id === undefined
                        ? $("#compose")
                        : message_lists.current!.get_row(edit_message_id);
                return util.the($container.find(`.compose-plus-menu-wrapper ${selector}`));
            };
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
                    compose_setup.toggle_global_time_picker(
                        get_anchor(".compose-plus-menu-picker-anchor"),
                    );
                }),
            );
            $popper.one(
                "click",
                ".compose-plus-menu-saved-snippets",
                run(() => {
                    saved_snippets_ui.open_saved_snippets_dropdown_from(
                        get_anchor(".compose-plus-menu-snippets-anchor"),
                    );
                }),
            );
            $popper.one(
                "click",
                ".compose-plus-menu-gif",
                run(() => {
                    gif_picker_ui.toggle_gif_picker(get_anchor(".compose-plus-menu-picker-anchor"));
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
