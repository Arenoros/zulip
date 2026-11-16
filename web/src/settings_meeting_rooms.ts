import {$} from "jquery";
import * as z from "zod/mini";

import render_admin_meeting_room_list from "../templates/settings/admin_meeting_room_list.hbs";
import render_meeting_room_form from "../templates/settings/meeting_room_form.hbs";

import {room_schema} from "./calendar_rooms.ts";
import type {CalendarRoom as MeetingRoom} from "./calendar_rooms.ts";
import * as channel from "./channel.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import * as ListWidget from "./list_widget.ts";
import * as scroll_util from "./scroll_util.ts";
import {current_user} from "./state_data.ts";
import * as ui_report from "./ui_report.ts";

const meta = {
    loaded: false,
};

let rooms: MeetingRoom[] = [];

export function reset(): void {
    meta.loaded = false;
}

function populate_rooms(): void {
    const $table = $("#admin_meeting_rooms_table").expectOne();
    ListWidget.create<MeetingRoom>($table, rooms, {
        name: "meeting_rooms_list",
        get_item: ListWidget.default_get_item,
        modifier_html(room) {
            return render_admin_meeting_room_list({
                room,
                capacity_label: room.capacity === null ? "" : String(room.capacity),
                can_modify: current_user.is_admin,
            });
        },
        filter: {
            $element: $table.closest(".settings-section").find<HTMLInputElement>("input.search"),
            predicate(room, value) {
                return (
                    room.name.toLowerCase().includes(value) ||
                    room.location.toLowerCase().includes(value)
                );
            },
            onupdate() {
                scroll_util.reset_scrollbar($table);
            },
        },
        $parent_container: $("#meeting-rooms").expectOne(),
        $simplebar_container: $("#meeting-rooms .progressive-table-wrapper"),
    });
}

// The rooms change only here, so they are fetched again after each
// change instead of being sent to all clients.
function fetch_rooms(): void {
    void channel.get({
        url: "/json/calendar/rooms",
        success(data) {
            if (!meta.loaded) {
                return;
            }
            rooms = z.object({rooms: z.array(room_schema)}).parse(data).rooms;
            populate_rooms();
        },
        error(xhr) {
            ui_report.error(
                $t_html({defaultMessage: "Failed to load the meeting rooms"}),
                xhr,
                $("#organization-status"),
            );
        },
    });
}

function get_form_data($form: JQuery): Record<string, string> {
    const capacity = String($form.find<HTMLInputElement>("#meeting-room-capacity").val()).trim();
    return {
        name: String($form.find<HTMLInputElement>("#meeting-room-name").val()),
        capacity: capacity === "" ? "null" : capacity,
        location: String($form.find<HTMLInputElement>("#meeting-room-location").val()),
        email: String($form.find<HTMLInputElement>("#meeting-room-email").val()),
    };
}

function open_room_form(room: MeetingRoom | undefined): void {
    const dialog_widget_id = dialog_widget.launch({
        modal_title_html:
            room === undefined
                ? $t_html({defaultMessage: "Add meeting room"})
                : $t_html({defaultMessage: "Edit meeting room"}),
        help_link: "/help/meeting-rooms",
        modal_content_html: render_meeting_room_form({
            name: room?.name ?? "",
            capacity: room?.capacity ?? "",
            location: room?.location ?? "",
            email: room?.email ?? "",
        }),
        modal_submit_button_text:
            room === undefined ? $t({defaultMessage: "Add"}) : $t({defaultMessage: "Save changes"}),
        id: "meeting-room-modal",
        on_click() {
            const data = get_form_data($(`#${CSS.escape(dialog_widget_id)}`));
            if (room === undefined) {
                if (data["capacity"] === "null") {
                    delete data["capacity"];
                }
                dialog_widget.submit_api_request(channel.post, "/json/calendar/rooms", data, {
                    success_continuation: fetch_rooms,
                });
            } else {
                dialog_widget.submit_api_request(
                    channel.patch,
                    `/json/calendar/rooms/${room.id}`,
                    data,
                    {success_continuation: fetch_rooms},
                );
            }
        },
        on_shown() {
            $(`#${CSS.escape(dialog_widget_id)} #meeting-room-name`).trigger("focus");
        },
    });
}

function get_room(element: HTMLElement): MeetingRoom | undefined {
    const room_id = Number($(element).closest("tr").attr("data-room-id"));
    return rooms.find((room) => room.id === room_id);
}

function set_archived(room: MeetingRoom, is_archived: boolean): void {
    void channel.patch({
        url: `/json/calendar/rooms/${room.id}`,
        data: {is_archived: JSON.stringify(is_archived)},
        success: fetch_rooms,
        error(xhr) {
            ui_report.error($t_html({defaultMessage: "Failed"}), xhr, $("#organization-status"));
        },
    });
}

export function set_up(): void {
    meta.loaded = true;
    rooms = [];
    populate_rooms();
    fetch_rooms();
    const $section = $("#meeting-rooms");
    $section.on("click", "#add-meeting-room-button", (e) => {
        e.preventDefault();
        open_room_form(undefined);
    });
    $section.on("click", ".edit-meeting-room", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();
        open_room_form(get_room(this));
    });
    $section.on(
        "click",
        ".archive-meeting-room, .unarchive-meeting-room",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            const room = get_room(this);
            if (room !== undefined) {
                set_archived(room, !room.is_archived);
            }
        },
    );
}
