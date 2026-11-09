import {$} from "jquery";
import * as z from "zod/mini";

import * as banners from "./banners.ts";
import * as channel from "./channel.ts";
import * as compose_banner from "./compose_banner.ts";
import * as compose_state from "./compose_state.ts";
import * as compose_validate from "./compose_validate.ts";
import {$t} from "./i18n.ts";
import * as people from "./people.ts";
import * as popup_banners from "./popup_banners.ts";
import {current_user} from "./state_data.ts";
import * as ui_util from "./ui_util.ts";
import {user_settings} from "./user_settings.ts";
import * as util from "./util.ts";

// Sync with the duration documented for `call op:ring` events.
export const RING_TIMEOUT_MS = 45 * 1000;
const RING_SOUND_INTERVAL_MS = 3 * 1000;
const RESULT_BANNER_DURATION_MS = 5 * 1000;

export type CallRingEvent = {
    op: "ring";
    message_id: number;
    caller_id: number;
    url: string;
    voice_only: boolean;
};

export type CallAnswerEvent = {
    op: "accept" | "decline";
    message_id: number;
    user_id: number;
};

export type CallCancelEvent = {
    op: "cancel";
    message_id: number;
};

type IncomingCall = {
    $banner: JQuery;
    url: string;
    timeout: ReturnType<typeof setTimeout>;
    ring_sound_interval: ReturnType<typeof setInterval>;
};

type OutgoingCall = {
    $banner: JQuery;
    timeout: ReturnType<typeof setTimeout>;
    unanswered_user_ids: Set<number>;
    declined_user_ids: number[];
};

const incoming_calls = new Map<number, IncomingCall>();
const outgoing_calls = new Map<number, OutgoingCall>();

const start_call_response_schema = z.object({message_id: z.number()});

// Sync with check_start_livekit_call, which puts the same link in the
// message for the call.
export function get_call_url(
    call_id: number,
    voice_only: boolean,
    conversation?: {dm_user_ids: number[]} | {channel_id: number},
): string {
    let url = `/calls/livekit/join?call_id=${call_id}`;
    if (conversation !== undefined) {
        url +=
            "dm_user_ids" in conversation
                ? `&dm=${util.sorted_ids(conversation.dm_user_ids).join(",")}`
                : `&channel_id=${conversation.channel_id}`;
    }
    return voice_only ? `${url}&voice_only=true` : url;
}

function open_call(url: string): void {
    window.open(url, "_blank", "noopener,noreferrer");
}

function format_names(user_ids: number[]): string {
    return util.format_array_as_list(
        user_ids.map((user_id) => people.get_full_name(user_id)),
        "long",
        "conjunction",
    );
}

function append_popup_banner(banner: banners.Banner, message_id: number): JQuery {
    const $banner = banners.append(banner, $("#popup_banners_wrapper"));
    $banner.attr("data-message-id", message_id);
    return $banner;
}

function update_call_ring(message_id: number, op: "accept" | "decline" | "cancel"): void {
    void channel.post({
        url: "/json/calls/livekit/ring",
        data: {message_id: JSON.stringify(message_id), op},
    });
}

export let start_call_from_compose = (call_id: number, voice_only: boolean): void => {
    let data: Record<string, string>;
    let url: string;
    let ring_user_ids: number[] = [];
    if (compose_state.get_message_type() === "stream") {
        const stream_id = compose_state.stream_id();
        if (stream_id === undefined) {
            compose_banner.show_error_message(
                compose_validate.NO_CHANNEL_SELECTED_ERROR_MESSAGE,
                compose_banner.CLASSNAMES.missing_stream,
                $("#compose_banners"),
            );
            return;
        }
        data = {
            type: "channel",
            channel_id: JSON.stringify(stream_id),
            topic: compose_state.topic(),
        };
        url = get_call_url(call_id, voice_only, {channel_id: stream_id});
    } else {
        if (!compose_validate.validate_private_message()) {
            return;
        }
        const recipient_ids = compose_state.private_message_recipient_ids();
        data = {type: "direct", to: JSON.stringify(recipient_ids)};
        url = get_call_url(call_id, voice_only, {
            dm_user_ids: [...recipient_ids, current_user.user_id],
        });
        ring_user_ids = recipient_ids.filter(
            (user_id) => user_id !== current_user.user_id && !people.is_valid_bot_user(user_id),
        );
    }

    // Browsers block windows that are not opened directly in response
    // to a click, so the call opens before the server responds.
    open_call(url);
    void channel.post({
        url: "/json/calls/livekit/start",
        data: {...data, call_id: JSON.stringify(call_id), voice_only: JSON.stringify(voice_only)},
        success(raw_data) {
            const {message_id} = start_call_response_schema.parse(raw_data);
            if (ring_user_ids.length > 0) {
                show_outgoing_call(message_id, ring_user_ids);
            }
        },
        error(xhr) {
            compose_banner.show_error_message(
                channel.xhr_error_message($t({defaultMessage: "Failed to start the call."}), xhr),
                compose_banner.CLASSNAMES.generic_compose_error,
                $("#compose_banners"),
            );
        },
    });
};

export function rewire_start_call_from_compose(value: typeof start_call_from_compose): void {
    start_call_from_compose = value;
}

function show_outgoing_call(message_id: number, user_ids: number[]): void {
    const $banner = append_popup_banner(
        {
            intent: "info",
            label: $t({defaultMessage: "Calling {names}…"}, {names: format_names(user_ids)}),
            buttons: [
                {
                    variant: "subtle",
                    label: $t({defaultMessage: "Cancel"}),
                    custom_classes: "outgoing-call-cancel",
                },
            ],
            close_button: false,
            custom_classes: "outgoing-call-banner popup-banner",
        },
        message_id,
    );
    const unanswered_user_ids = new Set(user_ids);
    outgoing_calls.set(message_id, {
        $banner,
        timeout: setTimeout(() => {
            update_call_ring(message_id, "cancel");
            end_outgoing_call(
                message_id,
                $t(
                    {defaultMessage: "{names} didn't answer."},
                    {names: format_names([...unanswered_user_ids])},
                ),
            );
        }, RING_TIMEOUT_MS),
        unanswered_user_ids,
        declined_user_ids: [],
    });
}

function end_outgoing_call(message_id: number, result_label?: string): void {
    const call = outgoing_calls.get(message_id);
    if (call === undefined) {
        return;
    }
    clearTimeout(call.timeout);
    outgoing_calls.delete(message_id);
    if (result_label === undefined) {
        popup_banners.fade_out_popup_banner(call.$banner);
        return;
    }
    call.$banner.find(".banner-label").text(result_label);
    call.$banner.find(".banner-action-buttons").hide();
    setTimeout(() => {
        popup_banners.fade_out_popup_banner(call.$banner);
    }, RESULT_BANNER_DURATION_MS);
}

function show_incoming_call(event: CallRingEvent): void {
    const caller_name = people.get_full_name(event.caller_id);
    const $banner = append_popup_banner(
        {
            intent: "info",
            label: event.voice_only
                ? $t({defaultMessage: "{name} is calling you (voice call)."}, {name: caller_name})
                : $t({defaultMessage: "{name} is calling you (video call)."}, {name: caller_name}),
            buttons: [
                {
                    variant: "solid",
                    intent: "success",
                    label: $t({defaultMessage: "Accept"}),
                    custom_classes: "incoming-call-accept",
                },
                {
                    variant: "solid",
                    intent: "danger",
                    label: $t({defaultMessage: "Decline"}),
                    custom_classes: "incoming-call-decline",
                },
            ],
            close_button: false,
            custom_classes: "incoming-call-banner popup-banner",
        },
        event.message_id,
    );
    incoming_calls.set(event.message_id, {
        $banner,
        url: event.url,
        timeout: setTimeout(() => {
            end_incoming_call(event.message_id);
        }, RING_TIMEOUT_MS),
        // The message with the call link already played the first
        // notification sound.
        ring_sound_interval: setInterval(() => {
            if (user_settings.enable_sounds) {
                void ui_util.play_audio(util.the($("#user-notification-sound-audio")));
            }
        }, RING_SOUND_INTERVAL_MS),
    });
}

function end_incoming_call(message_id: number): void {
    const call = incoming_calls.get(message_id);
    if (call === undefined) {
        return;
    }
    clearTimeout(call.timeout);
    clearInterval(call.ring_sound_interval);
    incoming_calls.delete(message_id);
    popup_banners.fade_out_popup_banner(call.$banner);
}

export function dispatch(event: CallRingEvent | CallAnswerEvent | CallCancelEvent): void {
    switch (event.op) {
        case "ring":
            if (!incoming_calls.has(event.message_id)) {
                show_incoming_call(event);
            }
            break;
        case "accept":
        case "decline": {
            if (event.user_id === current_user.user_id) {
                // We answered the call, possibly on another device.
                end_incoming_call(event.message_id);
                break;
            }
            const call = outgoing_calls.get(event.message_id);
            if (call === undefined) {
                break;
            }
            if (event.op === "accept") {
                end_outgoing_call(event.message_id);
                break;
            }
            call.unanswered_user_ids.delete(event.user_id);
            call.declined_user_ids.push(event.user_id);
            if (call.unanswered_user_ids.size === 0) {
                end_outgoing_call(
                    event.message_id,
                    $t(
                        {defaultMessage: "{names} declined the call."},
                        {names: format_names(call.declined_user_ids)},
                    ),
                );
            }
            break;
        }
        case "cancel":
            end_incoming_call(event.message_id);
            break;
    }
}

export function initialize(): void {
    $("#popup_banners_wrapper").on("click", ".incoming-call-accept", function (this: HTMLElement) {
        const message_id = Number($(this).closest(".banner").attr("data-message-id"));
        const call = incoming_calls.get(message_id);
        if (call === undefined) {
            return;
        }
        open_call(call.url);
        update_call_ring(message_id, "accept");
        end_incoming_call(message_id);
    });
    $("#popup_banners_wrapper").on("click", ".incoming-call-decline", function (this: HTMLElement) {
        const message_id = Number($(this).closest(".banner").attr("data-message-id"));
        update_call_ring(message_id, "decline");
        end_incoming_call(message_id);
    });
    $("#popup_banners_wrapper").on("click", ".outgoing-call-cancel", function (this: HTMLElement) {
        const message_id = Number($(this).closest(".banner").attr("data-message-id"));
        update_call_ring(message_id, "cancel");
        end_outgoing_call(message_id);
    });
}
