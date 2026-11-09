import assert from "minimalistic-assert";
import {
    ConnectionQuality,
    type Participant,
    Room,
    RoomEvent,
    Track,
    type TrackPublication,
} from "livekit-client";

import {page_params} from "./base_page_params.ts";
import {electron_bridge} from "./electron_bridge.ts";
import {$t} from "./i18n.ts";
import * as livekit_remote_control from "./livekit_remote_control.ts";
import {RemoteInput} from "./livekit_remote_input.ts";

assert(page_params.page_type === "livekit_call");
const {livekit_url, livekit_token, voice_only} = page_params;

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
const call_buttons = [microphone_button, camera_button, screen_share_button, leave_button];

const room = new Room({adaptiveStream: true, dynacast: true});
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

function show_status(message: string): void {
    status_element.textContent = message;
}

function get_tile(participant: Participant): HTMLElement {
    let tile = tiles.get(participant.identity);
    if (tile === undefined) {
        tile = document.createElement("div");
        tile.classList.add("livekit-call-tile", "livekit-call-tile-camera-off");
        const name_element = document.createElement("span");
        name_element.classList.add("livekit-call-tile-name");
        const name = participant.name ?? participant.identity;
        name_element.textContent =
            participant === room.localParticipant
                ? $t({defaultMessage: "{name} (you)"}, {name})
                : name;
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
    if (livekit_remote_control.is_controllable_screen_share(publication)) {
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
});
room.on(RoomEvent.TrackMuted, (_publication, participant) => {
    update_camera_state(participant);
    update_buttons();
});
room.on(RoomEvent.TrackUnmuted, (_publication, participant) => {
    update_camera_state(participant);
    update_buttons();
});
room.on(RoomEvent.ParticipantConnected, (participant) => {
    get_tile(participant);
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
    show_status(
        left_call
            ? $t({defaultMessage: "You left the call."})
            : $t({defaultMessage: "You were disconnected from the call."}),
    );
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
                livekit_remote_control.get_screen_share_publish_options(),
            ),
        $t({defaultMessage: "Could not share your screen."}),
    );
});
enable_audio_button.addEventListener("click", () => {
    void room.startAudio();
});
leave_button.addEventListener("click", () => {
    left_call = true;
    void room.disconnect();
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

    get_tile(room.localParticipant);
    for (const participant of room.remoteParticipants.values()) {
        get_tile(participant);
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
}

void join();
