import {$} from "jquery";
import _ from "lodash";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";
import * as z from "zod/mini";

import render_personal_section_name_modal from "../templates/personal_section_name_modal.hbs";
import render_left_sidebar_dm_popover from "../templates/popovers/left_sidebar/left_sidebar_dm_popover.hbs";
import render_left_sidebar_dm_section_popover from "../templates/popovers/left_sidebar/left_sidebar_dm_section_popover.hbs";

import * as channel from "./channel.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import * as personal_sections from "./personal_sections.ts";
import type {ConversationSection} from "./personal_sections.ts";
import * as popover_menus from "./popover_menus.ts";
import * as ui_report from "./ui_report.ts";
import * as ui_util from "./ui_util.ts";

const PERSONAL_SECTIONS_URL = "/json/users/me/personal_sections";

function conversation_sections_data(sections: ConversationSection[]): Record<string, string> {
    return {conversation_sections: JSON.stringify(sections)};
}

function update_conversation_sections(sections: ConversationSection[]): void {
    void channel.patch({
        url: PERSONAL_SECTIONS_URL,
        data: conversation_sections_data(sections),
        error(xhr) {
            const parsed = z.object({msg: z.string()}).safeParse(xhr.responseJSON);
            if (parsed.success) {
                ui_report.generic_embed_error(_.escape(parsed.data.msg), 3500);
            }
        },
    });
}

function check_name_in_dialog(name: string): boolean {
    if (name !== "") {
        return true;
    }
    ui_report.error($t_html({defaultMessage: "Enter a name."}), undefined, $("#dialog_error"));
    dialog_widget.hide_dialog_spinner();
    return false;
}

function launch_section_name_modal(opts: {
    modal_title_html: string;
    modal_submit_button_text: string;
    name: string;
    get_sections: (name: string) => ConversationSection[];
}): void {
    dialog_widget.launch({
        modal_title_html: opts.modal_title_html,
        modal_content_html: render_personal_section_name_modal({
            name: opts.name,
            max_section_name_length: personal_sections.MAX_SECTION_NAME_LENGTH,
        }),
        id: "personal_section_name_modal",
        modal_submit_button_text: opts.modal_submit_button_text,
        loading_spinner: true,
        on_shown: () => $("#personal_section_name").trigger("select"),
        on_click() {
            const name = $<HTMLInputElement>("input#personal_section_name").val()!.trim();
            if (!check_name_in_dialog(name)) {
                return;
            }
            dialog_widget.submit_api_request(
                channel.patch,
                PERSONAL_SECTIONS_URL,
                conversation_sections_data(opts.get_sections(name)),
            );
        },
    });
}

function add_conversation_section(user_ids_string: string): void {
    launch_section_name_modal({
        modal_title_html: $t_html({defaultMessage: "New section"}),
        modal_submit_button_text: $t({defaultMessage: "Create"}),
        name: "",
        get_sections: (name) =>
            personal_sections.with_conversation_section_added(name, user_ids_string),
    });
}

function rename_conversation_section(section_name: string): void {
    launch_section_name_modal({
        modal_title_html: $t_html({defaultMessage: "Rename section"}),
        modal_submit_button_text: $t({defaultMessage: "Save"}),
        name: section_name,
        get_sections: (name) =>
            personal_sections.with_conversation_section_renamed(section_name, name),
    });
}

function delete_conversation_section(section_name: string): void {
    confirm_dialog.launch({
        modal_title_html: $t_html({defaultMessage: "Delete section?"}),
        modal_content_html: $t_html({
            defaultMessage: "The conversations in it will stay in your direct messages.",
        }),
        is_compact: true,
        on_click() {
            update_conversation_sections(
                personal_sections.with_conversation_section_removed(section_name),
            );
        },
    });
}

function on_hidden(instance: tippy.Instance, name: "dm_actions" | "dm_section_actions"): void {
    ui_util.hide_left_sidebar_menu_icon();
    instance.destroy();
    popover_menus.popover_instances[name] = null;
}

export function initialize(): void {
    popover_menus.register_popover_menu(
        "#direct-messages-list .dm-sidebar-menu-icon, #modal-direct-messages-list .dm-sidebar-menu-icon",
        {
            ...popover_menus.left_sidebar_tippy_options,
            onShow(instance) {
                popover_menus.popover_instances.dm_actions = instance;
                ui_util.show_left_sidebar_menu_icon(instance.reference);
                popover_menus.on_show_prep(instance);

                const user_ids_string = $(instance.reference)
                    .closest(".dm-list-item")
                    .attr("data-user-ids-string");
                assert(user_ids_string !== undefined);
                const current_section_name =
                    personal_sections.get_conversation_section_name(user_ids_string);
                const sections = personal_sections.get_conversation_sections();
                instance.setContent(
                    ui_util.parse_html(
                        render_left_sidebar_dm_popover({
                            has_sections: sections.length > 0,
                            sections: sections.map((section) => ({
                                name: section.name,
                                is_current: section.name === current_section_name,
                            })),
                            is_in_section: current_section_name !== undefined,
                        }),
                    ),
                );
                return undefined;
            },
            onMount(instance) {
                const $popper = $(instance.popper);
                const user_ids_string = $(instance.reference)
                    .closest(".dm-list-item")
                    .attr("data-user-ids-string");
                assert(user_ids_string !== undefined);

                $popper.one("click", ".dm-popover-move-to-section", function (this: HTMLElement) {
                    update_conversation_sections(
                        personal_sections.with_conversation_moved(
                            user_ids_string,
                            $(this).attr("data-section-name"),
                        ),
                    );
                    popover_menus.hide_current_popover_if_visible(instance);
                });
                $popper.one("click", ".dm-popover-new-section", () => {
                    popover_menus.hide_current_popover_if_visible(instance);
                    add_conversation_section(user_ids_string);
                });
                $popper.one("click", ".dm-popover-remove-from-section", () => {
                    update_conversation_sections(
                        personal_sections.with_conversation_moved(user_ids_string, undefined),
                    );
                    popover_menus.hide_current_popover_if_visible(instance);
                });
                popover_menus.focus_popover(instance);
            },
            onHidden(instance) {
                on_hidden(instance, "dm_actions");
            },
        },
        {also_trigger_on_enter: true},
    );

    popover_menus.register_popover_menu(
        "#direct-messages-list .dm-section-sidebar-menu-icon, #modal-direct-messages-list .dm-section-sidebar-menu-icon",
        {
            ...popover_menus.left_sidebar_tippy_options,
            onShow(instance) {
                popover_menus.popover_instances.dm_section_actions = instance;
                ui_util.show_left_sidebar_menu_icon(instance.reference);
                popover_menus.on_show_prep(instance);
                instance.setContent(ui_util.parse_html(render_left_sidebar_dm_section_popover()));
                return undefined;
            },
            onMount(instance) {
                const $popper = $(instance.popper);
                const section_name = $(instance.reference)
                    .closest(".dm-list-section-header")
                    .attr("data-section-name");
                assert(section_name !== undefined);

                $popper.one("click", ".dm-section-popover-rename", () => {
                    popover_menus.hide_current_popover_if_visible(instance);
                    rename_conversation_section(section_name);
                });
                $popper.one("click", ".dm-section-popover-delete", () => {
                    popover_menus.hide_current_popover_if_visible(instance);
                    delete_conversation_section(section_name);
                });
                popover_menus.focus_popover(instance);
            },
            onHidden(instance) {
                on_hidden(instance, "dm_section_actions");
            },
        },
        {also_trigger_on_enter: true},
    );
}
