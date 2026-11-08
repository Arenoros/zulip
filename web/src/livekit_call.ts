import assert from "minimalistic-assert";
import {type Participant, Room, RoomEvent, Track, type TrackPublication} from "livekit-client";

import {page_params} from "./base_page_params.ts";
import {$t} from "./i18n.ts";
import * as livekit_remote_control from "./livekit_remote_control.ts";

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

function render_screen_share(
    media_element: HTMLMediaElement,
    publication: TrackPublication,
): HTMLElement {
    const screen_share_element = document.createElement("div");
    screen_share_element.classList.add("livekit-call-screen-share");
    screen_share_element.append(media_element);
    if (livekit_remote_control.is_controllable_screen_share(publication)) {
        const label_element = document.createElement("span");
        label_element.classList.add("livekit-call-screen-share-label");
        label_element.textContent = $t({defaultMessage: "Remote control available"});
        screen_share_element.append(label_element);
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
        const screen_share_element = render_screen_share(media_element, publication);
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
});
room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    remove_tile(participant);
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
    update_stage();
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
