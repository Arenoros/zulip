import assert from "minimalistic-assert";
import {
    ConnectionQuality,
    type Participant,
    Room,
    RoomEvent,
    Track,
    type TrackPublication,
    supportsAudioOutputSelection,
} from "livekit-client";
import * as z from "zod/mini";

import {page_params} from "./base_page_params.ts";
import * as csrf from "./csrf.ts";
import {electron_bridge} from "./electron_bridge.ts";
import {$t} from "./i18n.ts";
import * as livekit_call_invites from "./livekit_call_invites.ts";
import {localstorage} from "./localstorage.ts";
import * as livekit_remote_control from "./livekit_remote_control.ts";
import {RemoteInput} from "./livekit_remote_input.ts";
import {get_retry_backoff_seconds} from "./retry_backoff.ts";

assert(page_params.page_type === "livekit_call");
const {
    livekit_url,
    livekit_token,
    voice_only,
    remote_control_enabled,
    conversation_url,
    call_message_id,
} = page_params;

function get_element<T extends HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    assert(element !== null);
    return element;
}

const stage_element = get_element(".livekit-call-stage");
const participants_element = get_element(".livekit-call-participants");
const audio_element = get_element(".livekit-call-audio");
const status_element = get_element(".livekit-call-status");
const microphone_button = get_element<HTMLButtonElement>("#livekit-call-microphone");
const camera_button = get_element<HTMLButtonElement>("#livekit-call-camera");
const screen_share_button = get_element<HTMLButtonElement>("#livekit-call-screen-share");
const enable_audio_button = get_element<HTMLButtonElement>("#livekit-call-enable-audio");
const leave_button = get_element<HTMLButtonElement>("#livekit-call-leave");
const participants_toggle = get_element<HTMLButtonElement>("#livekit-call-participants-toggle");
type DeviceMenu = {toggle: HTMLButtonElement; menu: HTMLElement; kinds: MediaDeviceKind[]};
const device_menus: DeviceMenu[] = [
    {
        toggle: get_element<HTMLButtonElement>("#livekit-call-microphone-devices"),
        menu: get_element("#livekit-call-microphone-menu"),
        kinds: supportsAudioOutputSelection() ? ["audioinput", "audiooutput"] : ["audioinput"],
    },
    {
        toggle: get_element<HTMLButtonElement>("#livekit-call-camera-devices"),
        menu: get_element("#livekit-call-camera-menu"),
        kinds: ["videoinput"],
    },
];
const call_buttons = [
    participants_toggle,
    microphone_button,
    camera_button,
    screen_share_button,
    leave_button,
    ...device_menus.map(({toggle}) => toggle),
];
const controls_element = get_element(".livekit-call-controls");
const duration_element = get_element(".livekit-call-duration");
const body_element = get_element(".livekit-call-body");
const side_panel = get_element("#livekit-call-side-panel");
const side_panel_title = get_element(".livekit-call-side-panel-title");
const side_panel_close = get_element<HTMLButtonElement>(".livekit-call-side-panel-close");
const participant_list = get_element(".livekit-call-participant-list");
const invite_element = get_element(".livekit-call-invite");
const invite_search = get_element<HTMLInputElement>(".livekit-call-invite-search");
const invite_results = get_element(".livekit-call-invite-results");
const invited_element = get_element(".livekit-call-invited");
const invited_list = get_element(".livekit-call-invited-list");
const left_element = get_element(".livekit-call-left");
const left_message_element = get_element(".livekit-call-left-message");
const rejoin_button = get_element<HTMLButtonElement>(".livekit-call-rejoin");
get_element<HTMLAnchorElement>(".livekit-call-conversation-link").href = conversation_url;

const ls = localstorage();
const SAVED_DEVICES_KEY = "livekit_call_devices";
// The devices the user chose in earlier calls on this computer.
const saved_devices: Partial<Record<MediaDeviceKind, string | undefined>> =
    z
        .object({
            audioinput: z.optional(z.string()),
            audiooutput: z.optional(z.string()),
            videoinput: z.optional(z.string()),
        })
        .safeParse(ls.get(SAVED_DEVICES_KEY)).data ?? {};

function device_defaults(device_id: string | undefined): {deviceId?: string} {
    return device_id === undefined ? {} : {deviceId: device_id};
}

const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    // A device that is gone falls back to the default one.
    audioCaptureDefaults: device_defaults(saved_devices.audioinput),
    videoCaptureDefaults: device_defaults(saved_devices.videoinput),
    audioOutput: device_defaults(saved_devices.audiooutput),
});
const tiles = new Map<string, HTMLElement>();
// LiveKit can have detached a track from its elements by the time it
// reports the track as unsubscribed, so we track the elements ourselves,
// along with the element that shows them on the page.
const track_elements = new Map<
    Track,
    {media_element: HTMLMediaElement; page_element: HTMLElement}
>();
// Who may control each controllable screen share, and the elements
// showing it, by the identity of the participant sharing the screen.
const control_states = new Map<string, livekit_remote_control.ControlState>();
const remote_inputs = new Map<string, RemoteInput>();
const control_tokens = new Map<string, string>();
// The token of the current grant of control of our own screen share.
let own_control_token: string | undefined;
// Timers for the screens whose owner refused a request of the local
// participant less than REQUEST_COOLDOWN_MS ago.
const request_refusal_timers = new Map<string, ReturnType<typeof setTimeout>>();
const screen_share_controls = new Map<
    string,
    {label_element: HTMLElement; button_element: HTMLButtonElement}
>();
let left_call = false;
// Who has been called to join the call, and who has been in it, whose
// calls are over.
let call_rings = page_params.call_rings;
const joined_user_ids = new Set(page_params.call_joined_user_ids);
let invited_timeout: ReturnType<typeof setTimeout> | undefined;
type User = {user_id: number; full_name: string; is_active: boolean; is_bot: boolean};
let users_promise: Promise<Map<number, User>> | undefined;
let users: Map<number, User> | undefined;
let duration_interval: ReturnType<typeof setInterval> | undefined;
let status_timeout: ReturnType<typeof setTimeout> | undefined;
// The devices the call uses, and their names, to tell when they change.
const active_devices = new Map<MediaDeviceKind, {device_id: string; label: string}>();
// The devices the user chose in this call, which need no notice.
const chosen_devices = new Map<MediaDeviceKind, string>();

function show_status(message: string): void {
    clearTimeout(status_timeout);
    status_element.textContent = message;
}

// Unplugging a headset changes several devices at once, so notices
// that come together are shown together.
let notices: string[] = [];
function show_notice(message: string): void {
    notices.push(message);
    show_status(notices.join(" "));
    status_timeout = setTimeout(() => {
        notices = [];
        show_status("");
    }, 10 * 1000);
}

function get_device_kind_name(kind: MediaDeviceKind): string {
    switch (kind) {
        case "audioinput":
            return $t({defaultMessage: "Microphone"});
        case "audiooutput":
            return $t({defaultMessage: "Speakers"});
        case "videoinput":
            return $t({defaultMessage: "Camera"});
    }
}

function get_device_label(kind: MediaDeviceKind, device: MediaDeviceInfo, index: number): string {
    // Browsers hide device names from pages that may not use them.
    if (device.label === "") {
        return $t(
            {defaultMessage: "{device_kind} {number}"},
            {device_kind: get_device_kind_name(kind), number: index + 1},
        );
    }
    return device.label;
}

function get_active_device_id(kind: MediaDeviceKind): string | undefined {
    return room.getActiveDevice(kind) ?? saved_devices[kind];
}

// LiveKit switches to another device when the one the call uses goes
// away, and follows the system's default device.
async function note_active_device(kind: MediaDeviceKind): Promise<void> {
    const devices = await Room.getLocalDevices(kind, false);
    const device_id = get_active_device_id(kind) ?? "default";
    const index = devices.findIndex((device) => device.deviceId === device_id);
    const device = devices[index];
    if (device === undefined) {
        return;
    }
    const current = {device_id, label: get_device_label(kind, device, index)};
    const previous = active_devices.get(kind);
    active_devices.set(kind, current);
    if (
        previous === undefined ||
        (previous.device_id === current.device_id && previous.label === current.label) ||
        chosen_devices.get(kind) === current.device_id
    ) {
        return;
    }
    switch (kind) {
        case "audioinput":
            show_notice(
                $t({defaultMessage: "Your microphone changed to {device}."}, {device: current.label}),
            );
            break;
        case "audiooutput":
            show_notice(
                $t({defaultMessage: "Your speakers changed to {device}."}, {device: current.label}),
            );
            break;
        case "videoinput":
            show_notice(
                $t({defaultMessage: "Your camera changed to {device}."}, {device: current.label}),
            );
            break;
    }
}

async function choose_device(kind: MediaDeviceKind, device_id: string, label: string): Promise<void> {
    chosen_devices.set(kind, device_id);
    try {
        // Not exact, so that LiveKit can fall back to another device
        // when this one goes away.
        await room.switchActiveDevice(kind, device_id, false);
    } catch {
        show_status($t({defaultMessage: "Could not switch to {device}."}, {device: label}));
        return;
    }
    saved_devices[kind] = device_id;
    ls.set(SAVED_DEVICES_KEY, saved_devices);
}

function close_device_menu(device_menu: DeviceMenu, return_focus = false): void {
    device_menu.menu.hidden = true;
    device_menu.toggle.setAttribute("aria-expanded", "false");
    if (return_focus) {
        device_menu.toggle.focus();
    }
}

async function render_device_group(device_menu: DeviceMenu, kind: MediaDeviceKind): Promise<HTMLElement> {
    const devices = await Room.getLocalDevices(kind, false);
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    const heading = document.createElement("div");
    heading.id = `livekit-call-device-menu-${kind}`;
    heading.classList.add("livekit-call-device-menu-heading");
    heading.textContent = get_device_kind_name(kind);
    group.setAttribute("aria-labelledby", heading.id);
    group.append(heading);
    const active_device_id = get_active_device_id(kind);
    const checked_device_id = devices.some((device) => device.deviceId === active_device_id)
        ? active_device_id
        : devices[0]?.deviceId;
    for (const [index, device] of devices.entries()) {
        const label = get_device_label(kind, device, index);
        const item = document.createElement("button");
        item.type = "button";
        item.tabIndex = -1;
        item.classList.add("livekit-call-device-menu-item");
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(device.deviceId === checked_device_id));
        const check = document.createElement("i");
        check.classList.add("zulip-icon", "zulip-icon-check");
        check.setAttribute("aria-hidden", "true");
        const label_element = document.createElement("span");
        label_element.textContent = label;
        item.append(check, label_element);
        item.addEventListener("click", () => {
            close_device_menu(device_menu, true);
            void choose_device(kind, device.deviceId, label);
        });
        group.append(item);
    }
    return group;
}

async function open_device_menu(device_menu: DeviceMenu): Promise<void> {
    const groups = await Promise.all(
        device_menu.kinds.map(async (kind) => render_device_group(device_menu, kind)),
    );
    device_menu.menu.replaceChildren(...groups);
    device_menu.menu.hidden = false;
    device_menu.toggle.setAttribute("aria-expanded", "true");
    const items = [
        ...device_menu.menu.querySelectorAll<HTMLElement>(".livekit-call-device-menu-item"),
    ];
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
}

function get_display_name(participant: Participant): string {
    const name = participant.name ?? participant.identity;
    return participant === room.localParticipant ? $t({defaultMessage: "{name} (you)"}, {name}) : name;
}

function format_duration(total_seconds: number): string {
    const hours = Math.floor(total_seconds / 3600);
    const minutes = Math.floor((total_seconds % 3600) / 60);
    const seconds = String(total_seconds % 60).padStart(2, "0");
    if (hours === 0) {
        return `${minutes}:${seconds}`;
    }
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

function update_participant_list(): void {
    const participants = [room.localParticipant, ...room.remoteParticipants.values()];
    side_panel_title.textContent = $t(
        {defaultMessage: "Participants ({count})"},
        {count: participants.length},
    );
    participant_list.replaceChildren(
        ...participants.map((participant) => {
            const item = document.createElement("li");
            item.classList.add("livekit-call-participant");
            const name_element = document.createElement("span");
            name_element.classList.add("livekit-call-participant-name");
            name_element.textContent = get_display_name(participant);
            name_element.title = name_element.textContent;
            item.append(name_element);
            if (!participant.isMicrophoneEnabled) {
                const muted_element = document.createElement("i");
                muted_element.classList.add("zulip-icon", "zulip-icon-mic-off");
                muted_element.setAttribute("role", "img");
                muted_element.setAttribute("aria-label", $t({defaultMessage: "Muted"}));
                muted_element.title = $t({defaultMessage: "Muted"});
                item.append(muted_element);
            }
            return item;
        }),
    );
}

async function load_users(): Promise<Map<number, User>> {
    users_promise ??= (async () => {
        const response = await fetch("/json/users");
        const {members} = z
            .object({
                members: z.array(
                    z.object({
                        user_id: z.number(),
                        full_name: z.string(),
                        is_active: z.boolean(),
                        is_bot: z.boolean(),
                    }),
                ),
            })
            .parse(await response.json());
        users = new Map(members.map((user) => [user.user_id, user]));
        return users;
    })();
    return users_promise;
}

async function post(url: string, data: Record<string, string>): Promise<Response> {
    return fetch(url, {
        method: "POST",
        headers: {"X-CSRFToken": csrf.csrf_token ?? ""},
        body: new URLSearchParams(data),
    });
}

function get_connected_user_ids(): Set<number> {
    return new Set(
        [room.localParticipant, ...room.remoteParticipants.values()].map((participant) =>
            Number(participant.identity),
        ),
    );
}

async function invite(user_id: number): Promise<void> {
    assert(call_message_id !== null);
    const response = await post("/json/calls/livekit/invite", {
        message_id: JSON.stringify(call_message_id),
        user_ids: JSON.stringify([user_id]),
    });
    if (!response.ok) {
        const error = z.object({msg: z.string()}).safeParse(await response.json());
        show_notice(error.data?.msg ?? $t({defaultMessage: "Could not invite them to the call."}));
    }
}

function update_invited_list(): void {
    const invited_users = livekit_call_invites.get_invited_users(
        call_rings,
        joined_user_ids,
        Date.now() / 1000,
    );
    invited_element.hidden = invited_users.length === 0;
    if (invited_users.length > 0 && users === undefined) {
        void load_users().then(update_invited_list);
    }
    invited_list.replaceChildren(
        ...invited_users.map(({user_id, status}) => {
            const item = document.createElement("li");
            item.classList.add("livekit-call-participant");
            const name_element = document.createElement("span");
            name_element.classList.add("livekit-call-participant-name");
            name_element.textContent =
                users?.get(user_id)?.full_name ?? $t({defaultMessage: "Unknown user"});
            name_element.title = name_element.textContent;
            const status_element = document.createElement("span");
            status_element.classList.add("livekit-call-invited-status");
            switch (status) {
                case "calling":
                    status_element.textContent = $t({defaultMessage: "Calling…"});
                    break;
                case "declined":
                    status_element.textContent = $t({defaultMessage: "Declined"});
                    break;
                case "missed":
                    status_element.textContent = $t({defaultMessage: "Didn't answer"});
                    break;
            }
            const text_element = document.createElement("div");
            text_element.classList.add("livekit-call-invited-text");
            text_element.append(name_element, status_element);
            item.append(text_element);
            if (status !== "calling") {
                const call_again_button = document.createElement("button");
                call_again_button.type = "button";
                call_again_button.classList.add("livekit-call-button", "livekit-call-call-again");
                call_again_button.textContent = $t({defaultMessage: "Call again"});
                call_again_button.addEventListener("click", () => {
                    void invite(user_id);
                });
                item.append(call_again_button);
            }
            return item;
        }),
    );
    // Calls time out without an event.
    clearTimeout(invited_timeout);
    if (invited_users.some(({status}) => status === "calling")) {
        invited_timeout = setTimeout(update_invited_list, 1000);
    }
}

async function update_invite_results(): Promise<void> {
    const query = invite_search.value.trim().toLowerCase();
    if (query === "") {
        invite_results.replaceChildren();
        return;
    }
    const all_users = await load_users();
    const connected_user_ids = get_connected_user_ids();
    const matches = [...all_users.values()]
        .filter(
            (user) =>
                user.is_active &&
                !user.is_bot &&
                !connected_user_ids.has(user.user_id) &&
                user.full_name.toLowerCase().includes(query),
        )
        .slice(0, 8);
    if (matches.length === 0) {
        const empty_element = document.createElement("li");
        empty_element.classList.add("livekit-call-invite-empty");
        empty_element.textContent = $t({defaultMessage: "No matching people."});
        invite_results.replaceChildren(empty_element);
        return;
    }
    invite_results.replaceChildren(
        ...matches.map((user) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.classList.add("livekit-call-invite-result");
            button.textContent = user.full_name;
            button.addEventListener("click", () => {
                invite_search.value = "";
                invite_results.replaceChildren();
                invite_search.focus();
                void invite(user.user_id);
            });
            item.append(button);
            return item;
        }),
    );
}

// The call window does not load the Zulip web app, so it gets the
// events it needs, about who is being called, itself.
async function listen_for_call_events(): Promise<void> {
    const event_schema = z.looseObject({id: z.number()});
    const rings_event_schema = z.object({
        type: z.literal("call"),
        op: z.literal("rings"),
        message_id: z.number(),
        rings: z.array(livekit_call_invites.call_ring_schema),
    });
    let queue: {queue_id: string; last_event_id: number} | undefined;
    let failures = 0;
    while (!left_call) {
        try {
            if (queue === undefined) {
                const response = await post("/json/register", {
                    event_types: JSON.stringify(["call"]),
                    fetch_event_types: JSON.stringify([]),
                });
                queue = z
                    .object({queue_id: z.string(), last_event_id: z.number()})
                    .parse(await response.json());
            }
            const response = await fetch(
                `/json/events?${new URLSearchParams({
                    queue_id: queue.queue_id,
                    last_event_id: String(queue.last_event_id),
                })}`,
            );
            const data: unknown = await response.json();
            if (z.object({code: z.literal("BAD_EVENT_QUEUE_ID")}).safeParse(data).success) {
                queue = undefined;
                continue;
            }
            for (const event of z.object({events: z.array(event_schema)}).parse(data).events) {
                queue.last_event_id = Math.max(queue.last_event_id, event.id);
                const rings_event = rings_event_schema.safeParse(event);
                if (rings_event.success && rings_event.data.message_id === call_message_id) {
                    call_rings = rings_event.data.rings;
                    update_invited_list();
                }
            }
            failures = 0;
        } catch {
            failures += 1;
            await new Promise((resolve) => {
                setTimeout(resolve, get_retry_backoff_seconds(undefined, failures) * 1000);
            });
        }
    }
}

function set_side_panel_open(open: boolean): void {
    side_panel.hidden = !open;
    set_pressed(participants_toggle, open);
}

function get_tile(participant: Participant): HTMLElement {
    let tile = tiles.get(participant.identity);
    if (tile === undefined) {
        tile = document.createElement("div");
        tile.classList.add("livekit-call-tile", "livekit-call-tile-camera-off");
        const name_element = document.createElement("span");
        name_element.classList.add("livekit-call-tile-name");
        name_element.textContent = get_display_name(participant);
        tile.append(name_element);
        participants_element.append(tile);
        tiles.set(participant.identity, tile);
    }
    return tile;
}

function remove_tile(participant: Participant): void {
    tiles.get(participant.identity)?.remove();
    tiles.delete(participant.identity);
}

function update_camera_state(participant: Participant): void {
    const publication = participant.getTrackPublication(Track.Source.Camera);
    get_tile(participant).classList.toggle(
        "livekit-call-tile-camera-off",
        publication?.track === undefined || publication.isMuted,
    );
}

function update_stage(): void {
    stage_element.classList.toggle(
        "livekit-call-stage-active",
        stage_element.childElementCount > 0,
    );
}

function send_control_message(
    message: Parameters<typeof livekit_remote_control.encode_message>[0],
    // Everyone, when empty.
    destination_identities: string[] = [],
): void {
    void room.localParticipant
        .publishData(livekit_remote_control.encode_message(message), {
            reliable: true,
            topic: livekit_remote_control.REMOTE_CONTROL_TOPIC,
            destinationIdentities: destination_identities,
        })
        .catch(() => {
            electron_bridge?.stop_remote_control?.();
        });
}

// Tells the other participants who may control our screen share, and
// the controller its token.
function publish_own_control_state(): void {
    const control_state = control_states.get(room.localParticipant.identity);
    if (control_state === undefined || control_state.state === "none") {
        return;
    }
    send_control_message({type: "state", control_state});
    if (control_state.state === "controlled" && own_control_token !== undefined) {
        send_control_message({type: "grant", token: own_control_token}, [
            control_state.participant.identity,
        ]);
    }
}

function is_sharing_controllable_screen(): boolean {
    const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    return (
        publication !== undefined &&
        livekit_remote_control.is_controllable_screen_share(publication)
    );
}

function describe_control_state(
    owner_identity: string,
): ReturnType<typeof livekit_remote_control.describe_control_state> {
    const owner = room.getParticipantByIdentity(owner_identity);
    return livekit_remote_control.describe_control_state({
        control_state: control_states.get(owner_identity),
        owner_name: owner?.name ?? owner_identity,
        is_own_share: owner_identity === room.localParticipant.identity,
        local_identity: room.localParticipant.identity,
        keyboard_active: remote_inputs.get(owner_identity)?.keyboard_active ?? false,
        request_refused: request_refusal_timers.has(owner_identity),
    });
}

function update_screen_share_controls(owner_identity: string): void {
    const controls = screen_share_controls.get(owner_identity);
    if (controls === undefined) {
        return;
    }
    const {label, action} = describe_control_state(owner_identity);
    controls.label_element.textContent = label;
    // Narrow windows truncate the label.
    controls.label_element.title = label;
    controls.button_element.hidden = action === undefined;
    controls.button_element.disabled = action?.disabled === true;
    controls.button_element.textContent = action?.label ?? "";
}

function clear_request_refusal(owner_identity: string): void {
    clearTimeout(request_refusal_timers.get(owner_identity));
    request_refusal_timers.delete(owner_identity);
}

function render_screen_share(
    media_element: HTMLMediaElement,
    publication: TrackPublication,
    participant: Participant,
): HTMLElement {
    const screen_share_element = document.createElement("div");
    screen_share_element.classList.add("livekit-call-screen-share");
    screen_share_element.append(media_element);
    if (remote_control_enabled && livekit_remote_control.is_controllable_screen_share(publication)) {
        const controls_element = document.createElement("div");
        controls_element.classList.add("livekit-call-screen-share-controls");
        const label_element = document.createElement("span");
        label_element.classList.add("livekit-call-screen-share-label");
        const button_element = document.createElement("button");
        button_element.type = "button";
        button_element.classList.add("livekit-call-button", "livekit-call-screen-share-button");
        button_element.addEventListener("click", () => {
            switch (describe_control_state(participant.identity).action?.type) {
                case "request":
                    send_control_message({type: "request"}, [participant.identity]);
                    break;
                case "release":
                    control_tokens.delete(participant.identity);
                    remote_inputs.get(participant.identity)?.set_token(undefined);
                    send_control_message({type: "release"}, [participant.identity]);
                    break;
                case "stop":
                    electron_bridge?.stop_remote_control?.();
                    break;
                case undefined:
                    break;
            }
        });
        controls_element.append(label_element, button_element);
        screen_share_element.append(controls_element);
        screen_share_controls.set(participant.identity, {label_element, button_element});
        update_screen_share_controls(participant.identity);
        if (participant !== room.localParticipant && media_element instanceof HTMLVideoElement) {
            const remote_input = new RemoteInput(
                media_element,
                async (token, sequence, event) => {
                    await room.localParticipant.publishData(
                        livekit_remote_control.encode_message(
                            event.type === "key"
                                ? {type: "key", token, sequence, code: event.code, down: event.down}
                                : {type: "mouse", token, sequence, event},
                        ),
                        {
                            reliable: event.type !== "move",
                            topic: livekit_remote_control.REMOTE_CONTROL_TOPIC,
                            destinationIdentities: [participant.identity],
                        },
                    );
                },
                () => {
                    media_element.classList.toggle(
                        "livekit-call-video-keyboard",
                        remote_input.keyboard_active,
                    );
                    update_screen_share_controls(participant.identity);
                },
            );
            remote_inputs.set(participant.identity, remote_input);
            remote_input.set_token(control_tokens.get(participant.identity));
        }
    }
    return screen_share_element;
}

function attach_track(track: Track, publication: TrackPublication, participant: Participant): void {
    // Playing back our own microphone would only produce an echo.
    if (track.kind === Track.Kind.Audio && participant === room.localParticipant) {
        return;
    }

    const media_element = track.attach();
    if (track.kind === Track.Kind.Audio) {
        audio_element.append(media_element);
        track_elements.set(track, {media_element, page_element: media_element});
        return;
    }

    media_element.classList.add("livekit-call-video");
    if (track.source === Track.Source.ScreenShare) {
        const screen_share_element = render_screen_share(media_element, publication, participant);
        stage_element.append(screen_share_element);
        track_elements.set(track, {media_element, page_element: screen_share_element});
        update_stage();
    } else {
        get_tile(participant).prepend(media_element);
        track_elements.set(track, {media_element, page_element: media_element});
        update_camera_state(participant);
    }
}

function detach_track(track: Track, participant: Participant): void {
    const elements = track_elements.get(track);
    if (elements !== undefined) {
        track.detach(elements.media_element);
        elements.page_element.remove();
        track_elements.delete(track);
    }
    if (track.source === Track.Source.ScreenShare) {
        remote_inputs.get(participant.identity)?.destroy();
        remote_inputs.delete(participant.identity);
        control_tokens.delete(participant.identity);
        screen_share_controls.delete(participant.identity);
        control_states.delete(participant.identity);
        clear_request_refusal(participant.identity);
    }
    update_stage();
    if (tiles.has(participant.identity)) {
        update_camera_state(participant);
    }
}

function set_pressed(button: HTMLButtonElement, pressed: boolean): void {
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("livekit-call-button-pressed", pressed);
}

function update_buttons(): void {
    const local_participant = room.localParticipant;
    set_pressed(microphone_button, local_participant.isMicrophoneEnabled);
    set_pressed(camera_button, local_participant.isCameraEnabled);
    set_pressed(screen_share_button, local_participant.isScreenShareEnabled);
}

function update_enable_audio_button(): void {
    enable_audio_button.hidden = room.canPlaybackAudio;
}

async function set_device_enabled(
    enable: () => Promise<unknown>,
    error_message: string,
): Promise<void> {
    try {
        await enable();
    } catch (error) {
        // Closing the screen picker without choosing a screen is not
        // an error worth reporting.
        if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
            show_status(error_message);
        }
    }
    update_buttons();
}

room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    attach_track(track, publication, participant);
});
room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    detach_track(track, participant);
});
room.on(RoomEvent.LocalTrackPublished, (publication, participant) => {
    if (publication.track !== undefined) {
        attach_track(publication.track, publication, participant);
    }
    update_buttons();
    update_participant_list();
});
room.on(RoomEvent.LocalTrackUnpublished, (publication, participant) => {
    if (publication.track !== undefined) {
        detach_track(publication.track, participant);
    }
    // A full reconnect republishes tracks without stopping them.
    if (
        publication.source === Track.Source.ScreenShare &&
        publication.track?.mediaStreamTrack.readyState !== "live"
    ) {
        electron_bridge?.screen_share_stopped?.();
    }
    update_buttons();
    update_participant_list();
});
room.on(RoomEvent.TrackMuted, (_publication, participant) => {
    update_camera_state(participant);
    update_buttons();
    update_participant_list();
});
room.on(RoomEvent.TrackUnmuted, (_publication, participant) => {
    update_camera_state(participant);
    update_buttons();
    update_participant_list();
});
room.on(RoomEvent.TrackPublished, update_participant_list);
room.on(RoomEvent.TrackUnpublished, update_participant_list);
room.on(RoomEvent.ParticipantConnected, (participant) => {
    get_tile(participant);
    update_participant_list();
    joined_user_ids.add(Number(participant.identity));
    update_invited_list();
    const control_state = control_states.get(room.localParticipant.identity);
    if (control_state !== undefined && is_sharing_controllable_screen()) {
        send_control_message({type: "state", control_state}, [participant.identity]);
    }
});
room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    remote_inputs.get(participant.identity)?.destroy();
    remote_inputs.delete(participant.identity);
    control_tokens.delete(participant.identity);
    control_states.delete(participant.identity);
    clear_request_refusal(participant.identity);
    remove_tile(participant);
    update_participant_list();
    electron_bridge?.remote_control_participant_left?.(participant.identity);
});
room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    const control_state = control_states.get(room.localParticipant.identity);
    if (
        quality === ConnectionQuality.Lost &&
        control_state?.state === "controlled" &&
        control_state.participant.identity === participant.identity
    ) {
        electron_bridge?.stop_remote_control?.();
    }
});
// Remote control ends whenever either side loses its connection to the
// call, even briefly, and takes a new request to start again.
room.on(RoomEvent.Reconnecting, () => {
    electron_bridge?.stop_remote_control?.();
    for (const remote_input of remote_inputs.values()) {
        remote_input.set_token(undefined);
    }
    control_tokens.clear();
});
room.on(RoomEvent.Reconnected, () => {
    const local_identity = room.localParticipant.identity;
    for (const [owner_identity, control_state] of control_states) {
        if (owner_identity === local_identity) {
            // Others may have missed changes while we were reconnecting.
            publish_own_control_state();
        } else if (
            control_state.state === "controlled" &&
            control_state.participant.identity === local_identity
        ) {
            // The owner may not have noticed that we lost the connection.
            send_control_message({type: "release"}, [owner_identity]);
        }
    }
});
room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic !== livekit_remote_control.REMOTE_CONTROL_TOPIC || participant === undefined) {
        return;
    }
    const message = livekit_remote_control.decode_message(payload);
    switch (message?.type) {
        case "state": {
            // Participants only report the state of their own screen share.
            if (
                livekit_remote_control.is_refused_request(
                    control_states.get(participant.identity),
                    message.control_state,
                    room.localParticipant.identity,
                )
            ) {
                clear_request_refusal(participant.identity);
                request_refusal_timers.set(
                    participant.identity,
                    setTimeout(() => {
                        request_refusal_timers.delete(participant.identity);
                        update_screen_share_controls(participant.identity);
                    }, livekit_remote_control.REQUEST_COOLDOWN_MS),
                );
            }
            control_states.set(participant.identity, message.control_state);
            if (
                message.control_state.state !== "controlled" ||
                message.control_state.participant.identity !== room.localParticipant.identity
            ) {
                control_tokens.delete(participant.identity);
                remote_inputs.get(participant.identity)?.set_token(undefined);
            }
            update_screen_share_controls(participant.identity);
            break;
        }
        case "grant": {
            const state = control_states.get(participant.identity);
            if (
                state?.state === "controlled" &&
                state.participant.identity === room.localParticipant.identity
            ) {
                control_tokens.set(participant.identity, message.token);
                remote_inputs.get(participant.identity)?.set_token(message.token);
            }
            break;
        }
        case "mouse":
        case "key":
            if (is_sharing_controllable_screen()) {
                electron_bridge?.send_remote_control_input?.(participant.identity, message);
            }
            break;
        case "request":
            if (is_sharing_controllable_screen()) {
                electron_bridge?.request_remote_control?.(
                    participant.identity,
                    participant.name ?? participant.identity,
                );
            }
            break;
        case "release": {
            const control_state = control_states.get(room.localParticipant.identity);
            if (
                control_state?.state === "controlled" &&
                control_state.participant.identity === participant.identity
            ) {
                electron_bridge?.stop_remote_control?.();
            }
            break;
        }
        case undefined:
            break;
    }
});
electron_bridge?.on_event("remote_control_state", (state) => {
    const control_state = livekit_remote_control.parse_control_state(state);
    if (control_state === undefined) {
        return;
    }
    control_states.set(room.localParticipant.identity, control_state);
    own_control_token = livekit_remote_control.parse_control_token(state);
    update_screen_share_controls(room.localParticipant.identity);
    publish_own_control_state();
});
room.on(RoomEvent.AudioPlaybackStatusChanged, update_enable_audio_button);
room.on(RoomEvent.Disconnected, () => {
    clearInterval(duration_interval);
    left_message_element.textContent = left_call
        ? $t({defaultMessage: "You left the call."})
        : $t({defaultMessage: "You were disconnected from the call."});
    controls_element.hidden = true;
    duration_element.hidden = true;
    body_element.hidden = true;
    left_element.hidden = false;
    rejoin_button.focus();
    for (const button of call_buttons) {
        button.disabled = true;
    }
    enable_audio_button.hidden = true;
    stage_element.replaceChildren();
    participants_element.replaceChildren();
    audio_element.replaceChildren();
    tiles.clear();
    track_elements.clear();
    for (const remote_input of remote_inputs.values()) {
        remote_input.destroy();
    }
    remote_inputs.clear();
    control_tokens.clear();
    control_states.clear();
    for (const timer of request_refusal_timers.values()) {
        clearTimeout(timer);
    }
    request_refusal_timers.clear();
    screen_share_controls.clear();
    update_stage();
    electron_bridge?.screen_share_stopped?.();
});

microphone_button.addEventListener("click", () => {
    void set_device_enabled(
        async () =>
            room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled),
        $t({defaultMessage: "Could not access your microphone."}),
    );
});
camera_button.addEventListener("click", () => {
    void set_device_enabled(
        async () => room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled),
        $t({defaultMessage: "Could not access your camera."}),
    );
});
screen_share_button.addEventListener("click", () => {
    void set_device_enabled(
        async () =>
            room.localParticipant.setScreenShareEnabled(
                !room.localParticipant.isScreenShareEnabled,
                undefined,
                livekit_remote_control.get_screen_share_publish_options(remote_control_enabled),
            ),
        $t({defaultMessage: "Could not share your screen."}),
    );
});
enable_audio_button.addEventListener("click", () => {
    void room.startAudio();
});
leave_button.addEventListener("click", () => {
    left_call = true;
    void room.disconnect().then(() => {
        // Browsers only let a page close a window that a script opened,
        // or one with nothing to go back to; otherwise the page shows
        // that the user left.
        window.close();
    });
});
participants_toggle.addEventListener("click", () => {
    set_side_panel_open(participants_toggle.getAttribute("aria-pressed") !== "true");
});
side_panel_close.addEventListener("click", () => {
    set_side_panel_open(false);
    participants_toggle.focus();
});
side_panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        set_side_panel_open(false);
        participants_toggle.focus();
    }
});
for (const device_menu of device_menus) {
    device_menu.toggle.addEventListener("click", () => {
        if (!device_menu.menu.hidden) {
            close_device_menu(device_menu);
            return;
        }
        for (const other_menu of device_menus) {
            close_device_menu(other_menu);
        }
        void open_device_menu(device_menu);
    });
    device_menu.menu.addEventListener("keydown", (event) => {
        const items = [
            ...device_menu.menu.querySelectorAll<HTMLElement>(".livekit-call-device-menu-item"),
        ];
        const index = items.findIndex((item) => item === document.activeElement);
        let next_item;
        switch (event.key) {
            case "ArrowDown":
                next_item = items[(index + 1) % items.length];
                break;
            case "ArrowUp":
                next_item = items.at(index - 1);
                break;
            case "Home":
                next_item = items[0];
                break;
            case "End":
                next_item = items.at(-1);
                break;
            case "Escape":
                close_device_menu(device_menu, true);
                event.preventDefault();
                return;
            case "Tab":
                close_device_menu(device_menu);
                return;
            default:
                return;
        }
        event.preventDefault();
        next_item?.focus();
    });
}
document.addEventListener("click", (event) => {
    for (const device_menu of device_menus) {
        if (
            !device_menu.menu.hidden &&
            event.target instanceof Node &&
            !device_menu.menu.contains(event.target) &&
            !device_menu.toggle.contains(event.target)
        ) {
            close_device_menu(device_menu);
        }
    }
});
room.on(RoomEvent.ActiveDeviceChanged, (kind) => {
    void note_active_device(kind);
});
room.on(RoomEvent.MediaDevicesChanged, () => {
    for (const device_menu of device_menus) {
        if (!device_menu.menu.hidden) {
            void open_device_menu(device_menu);
        }
    }
});
invite_search.addEventListener("input", () => {
    void update_invite_results();
});
rejoin_button.addEventListener("click", () => {
    // The server checks whether the call is still going on.
    window.location.reload();
});

async function join(): Promise<void> {
    show_status($t({defaultMessage: "Connecting…"}));
    try {
        await room.connect(livekit_url, livekit_token);
    } catch {
        show_status($t({defaultMessage: "Could not connect to the call."}));
        return;
    }
    show_status("");

    const connected_at = Date.now();
    duration_element.textContent = format_duration(0);
    duration_interval = setInterval(() => {
        duration_element.textContent = format_duration(
            Math.floor((Date.now() - connected_at) / 1000),
        );
    }, 1000);
    get_tile(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
        get_tile(participant);
        joined_user_ids.add(Number(participant.identity));
    }
    update_participant_list();
    if (call_message_id !== null) {
        invite_element.hidden = false;
        update_invited_list();
        void listen_for_call_events();
    }
    for (const button of call_buttons) {
        button.disabled = false;
    }
    update_enable_audio_button();

    await set_device_enabled(
        async () => room.localParticipant.setMicrophoneEnabled(true),
        $t({defaultMessage: "Could not access your microphone."}),
    );
    if (!voice_only) {
        await set_device_enabled(
            async () => room.localParticipant.setCameraEnabled(true),
            $t({defaultMessage: "Could not access your camera."}),
        );
    }
    for (const kind of ["audioinput", "audiooutput", "videoinput"] as const) {
        await note_active_device(kind);
    }
}

void join();
