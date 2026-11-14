import {$} from "jquery";
import assert from "minimalistic-assert";
import * as tippy from "tippy.js";

import render_conversation_people_popover from "../templates/popovers/conversation_people_popover.hbs";
import render_start_group_chat_modal from "../templates/start_group_chat_modal.hbs";

import * as browser_history from "./browser_history.ts";
import * as buddy_data from "./buddy_data.ts";
import * as dialog_widget from "./dialog_widget.ts";
import * as hash_util from "./hash_util.ts";
import {$t, $t_html} from "./i18n.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import type {User} from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import * as popover_menus from "./popover_menus.ts";
import {realm} from "./state_data.ts";
import {parse_html} from "./ui_util.ts";
import * as user_card_popover from "./user_card_popover.ts";
import * as user_pill from "./user_pill.ts";
import * as util from "./util.ts";

// Everyone in the open direct message conversation, the current user
// first.
function get_participants(): User[] {
    const user_ids = narrow_state.pm_ids();
    assert(user_ids !== undefined);
    const strcmp = util.make_strcmp();
    const others = user_ids
        .filter((user_id) => !people.is_my_user_id(user_id))
        .map((user_id) => people.get_user_by_id_assert_valid(user_id, true))
        .toSorted((a, b) => strcmp(a.full_name, b.full_name));
    return [people.get_by_user_id(people.my_current_user_id()), ...others];
}

function get_user_circle_class(user: User): string | undefined {
    if (user.is_bot || user.is_inaccessible_user || realm.realm_presence_disabled) {
        return undefined;
    }
    return buddy_data.get_user_circle_class(
        user.user_id,
        !people.is_person_active(user.user_id),
    );
}

// A group direct message is a fixed set of people, so adding someone
// to a one-on-one conversation starts a new conversation.
function open_start_group_chat_modal(participant_ids: number[]): void {
    let pills: user_pill.UserPillWidget | undefined;
    dialog_widget.launch({
        modal_title_html: $t_html({defaultMessage: "Start a group chat"}),
        modal_content_html: render_start_group_chat_modal(),
        modal_submit_button_text: $t({defaultMessage: "Start"}),
        id: "start-group-chat-modal",
        post_render(modal_unique_id) {
            const $modal = $(`#${CSS.escape(modal_unique_id)}`);
            const $submit_button = $modal.find(".dialog_submit_button");
            pills = user_pill.create_pills($modal.find(".start-group-chat-people"), {
                exclude_inaccessible_users: true,
            });
            pill_typeahead.set_up_user($modal.find(".start-group-chat-people .input"), pills, {
                exclude_user_ids: participant_ids,
            });
            const update_submit_button = (): void => {
                $submit_button.prop("disabled", pills!.items().length === 0);
            };
            pills.onPillCreate(update_submit_button);
            pills.onPillRemove(update_submit_button);
            update_submit_button();
        },
        on_shown() {
            $("#start-group-chat-modal .start-group-chat-people .input").trigger("focus");
        },
        on_click() {
            assert(pills !== undefined);
            const user_ids = new Set([...participant_ids, ...user_pill.get_user_ids(pills)]);
            dialog_widget.close();
            browser_history.go_to_location(
                hash_util.pm_with_url(people.sorted_other_user_ids([...user_ids]).join(",")),
            );
        },
    });
}

// The people button of the header of a direct message conversation
// lists everyone in it, and starts a group chat from a one-on-one
// conversation.
export function initialize(): void {
    tippy.delegate("body", {
        ...popover_menus.default_popover_props,
        theme: "popover-menu",
        target: ".message-view-header-people-button",
        placement: "bottom-end",
        onShow(instance) {
            const participants = get_participants();
            instance.setContent(
                parse_html(
                    render_conversation_people_popover({
                        people: participants.map((user) => ({
                            user_id: user.user_id,
                            full_name: user.full_name,
                            avatar_url: people.small_avatar_url_for_person(user),
                            user_circle_class: get_user_circle_class(user),
                            is_me: people.is_my_user_id(user.user_id),
                        })),
                        can_start_group_chat:
                            participants.length <= 2 &&
                            participants.every(
                                (user) =>
                                    !user.is_inaccessible_user &&
                                    people.is_person_active(user.user_id),
                            ),
                    }),
                ),
            );
            $(instance.reference)
                .attr("aria-expanded", "true")
                .addClass("message-view-header-people-button-active");
            popover_menus.popover_instances.conversation_people = instance;
        },
        onMount(instance) {
            const $popper = $(instance.popper);
            $popper.one("click", ".conversation-people-member", function (this: HTMLElement, e) {
                e.preventDefault();
                e.stopPropagation();
                const user = people.get_by_user_id(Number(this.dataset["userId"]));
                popover_menus.hide_current_popover_if_visible(instance);
                // The button has this menu's popover, so the user's card
                // opens from its icon.
                user_card_popover.toggle_user_card_popover(
                    util.the($(instance.reference).find(".zulip-icon")),
                    user,
                    "bottom-end",
                );
            });
            $popper.one("click", ".conversation-people-start-group-chat", (e) => {
                e.preventDefault();
                e.stopPropagation();
                popover_menus.hide_current_popover_if_visible(instance);
                open_start_group_chat_modal(get_participants().map((user) => user.user_id));
            });
        },
        onHidden(instance) {
            $(instance.reference)
                .attr("aria-expanded", "false")
                .removeClass("message-view-header-people-button-active");
            instance.destroy();
            popover_menus.popover_instances.conversation_people = null;
        },
    });
}
