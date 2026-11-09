import type {TrackPublication, TrackPublishOptions} from "livekit-client";
import * as z from "zod/mini";

import {electron_bridge} from "./electron_bridge.ts";
import {$t} from "./i18n.ts";
import {type MouseEvent, mouse_event_schema} from "./livekit_remote_input.ts";

// Screens shared from a desktop app that lets call participants
// control them are published under this track name.
const CONTROLLABLE_SCREEN_SHARE_TRACK_NAME = "zulip-controllable-screen-share";

// Participants coordinate remote control with data messages under this
// topic.  Only the desktop app of the owner of a screen decides who may
// control it; these messages relay requests and its decisions.
export const REMOTE_CONTROL_TOPIC = "zulip-remote-control";
const PROTOCOL_VERSION = 1;

const participant_schema = z.object({identity: z.string(), name: z.string()});

// Who may control a screen share, as the desktop app of its owner
// reports it.
const control_state_schema = z.discriminatedUnion("state", [
    z.object({state: z.literal("none")}),
    z.object({state: z.literal("shared")}),
    z.object({state: z.literal("requested"), participant: participant_schema}),
    z.object({state: z.literal("controlled"), participant: participant_schema}),
]);
export type ControlState = z.infer<typeof control_state_schema>;

const message_schema = z.discriminatedUnion("type", [
    z.object({version: z.literal(PROTOCOL_VERSION), type: z.literal("request")}),
    z.object({version: z.literal(PROTOCOL_VERSION), type: z.literal("release")}),
    z.object({
        version: z.literal(PROTOCOL_VERSION),
        type: z.literal("grant"),
        token: z.string().check(z.length(32)),
    }),
    z.object({
        version: z.literal(PROTOCOL_VERSION),
        type: z.literal("mouse"),
        token: z.string().check(z.length(32)),
        sequence: z.int().check(z.minimum(1)),
        event: mouse_event_schema,
    }),
    z.object({
        version: z.literal(PROTOCOL_VERSION),
        type: z.literal("key"),
        token: z.string().check(z.length(32)),
        sequence: z.int().check(z.minimum(1)),
        code: z.string().check(z.maxLength(32)),
        down: z.boolean(),
    }),
    z.object({
        version: z.literal(PROTOCOL_VERSION),
        type: z.literal("state"),
        control_state: control_state_schema,
    }),
]);
type RemoteControlMessage = z.infer<typeof message_schema>;
type OutgoingMessage =
    | {type: "request"}
    | {type: "release"}
    | {type: "state"; control_state: ControlState}
    | {type: "grant"; token: string}
    | {type: "mouse"; token: string; sequence: number; event: MouseEvent}
    | {type: "key"; token: string; sequence: number; code: string; down: boolean};

export function get_screen_share_publish_options(): TrackPublishOptions {
    if (electron_bridge?.get_remote_control_supported?.() === true) {
        return {name: CONTROLLABLE_SCREEN_SHARE_TRACK_NAME};
    }
    return {};
}

export function is_controllable_screen_share(publication: TrackPublication): boolean {
    return publication.trackName === CONTROLLABLE_SCREEN_SHARE_TRACK_NAME;
}

export function encode_message(message: OutgoingMessage): Uint8Array<ArrayBuffer> {
    const data = message_schema.parse({version: PROTOCOL_VERSION, ...message});
    return new TextEncoder().encode(JSON.stringify(data));
}

export function decode_message(payload: Uint8Array): RemoteControlMessage | undefined {
    if (payload.byteLength > 4096) {
        return undefined;
    }
    let data: unknown;
    try {
        data = JSON.parse(new TextDecoder().decode(payload));
    } catch {
        return undefined;
    }
    const result = message_schema.safeParse(data);
    return result.success ? result.data : undefined;
}

// Read the token only from the owner's desktop event. Public state is
// always parsed separately, so broadcasting it cannot disclose a token.
export function parse_control_token(data: unknown): string | undefined {
    const result = z
        .object({
            state: z.literal("controlled"),
            token: z.string().check(z.length(32)),
        })
        .safeParse(data);
    return result.success ? result.data.token : undefined;
}

export function parse_control_state(data: unknown): ControlState | undefined {
    const result = control_state_schema.safeParse(data);
    return result.success ? result.data : undefined;
}

// The owner's desktop app ignores further requests from a participant
// for this long after refusing one.
export const REQUEST_COOLDOWN_MS = 30 * 1000;

// A request of the local participant ends with the screen still shared
// only when the owner refused it, or did not answer in time.
export function is_refused_request(
    previous: ControlState | undefined,
    next: ControlState,
    local_identity: string,
): boolean {
    return (
        previous?.state === "requested" &&
        previous.participant.identity === local_identity &&
        next.state === "shared"
    );
}

export type ControlAction = "request" | "release" | "stop";

export function describe_control_state({
    control_state,
    owner_name,
    is_own_share,
    local_identity,
    keyboard_active,
    request_refused,
}: {
    control_state: ControlState | undefined;
    owner_name: string;
    is_own_share: boolean;
    local_identity: string;
    // Whether the local participant's keyboard goes to the shared screen.
    keyboard_active: boolean;
    // Whether the owner refused the local participant's request less
    // than REQUEST_COOLDOWN_MS ago.
    request_refused: boolean;
}): {
    label: string;
    action: {type: ControlAction; label: string; disabled?: boolean} | undefined;
} {
    if (
        control_state === undefined ||
        control_state.state === "none" ||
        control_state.state === "shared"
    ) {
        if (request_refused) {
            return {
                label: $t(
                    {defaultMessage: "{name} didn't allow control. You can ask again in a moment."},
                    {name: owner_name},
                ),
                action: {
                    type: "request",
                    label: $t({defaultMessage: "Request control"}),
                    disabled: true,
                },
            };
        }
        return {
            label: $t({defaultMessage: "Remote control available"}),
            action: is_own_share
                ? undefined
                : {type: "request", label: $t({defaultMessage: "Request control"})},
        };
    }

    const {participant} = control_state;
    const is_local_participant = !is_own_share && participant.identity === local_identity;
    if (control_state.state === "requested") {
        return {
            label: is_local_participant
                ? $t({defaultMessage: "Waiting for {name} to allow control…"}, {name: owner_name})
                : $t({defaultMessage: "{name} requested control"}, {name: participant.name}),
            action: undefined,
        };
    }

    if (is_own_share) {
        return {
            label: $t(
                {defaultMessage: "{name} is controlling your screen"},
                {name: participant.name},
            ),
            action: {type: "stop", label: $t({defaultMessage: "Stop control"})},
        };
    }
    if (is_local_participant) {
        return {
            label: keyboard_active
                ? $t({
                      defaultMessage:
                          "Your keyboard controls this screen. Click outside it to stop.",
                  })
                : $t({defaultMessage: "You are controlling this screen. Click it to type."}),
            action: {type: "release", label: $t({defaultMessage: "Stop controlling"})},
        };
    }
    return {
        label: $t({defaultMessage: "{name} is controlling this screen"}, {name: participant.name}),
        action: undefined,
    };
}
