import type {TrackPublication, TrackPublishOptions} from "livekit-client";

import {electron_bridge} from "./electron_bridge.ts";

// Screens shared from a desktop app that lets call participants
// control them are published under this track name.
const CONTROLLABLE_SCREEN_SHARE_TRACK_NAME = "zulip-controllable-screen-share";

export function get_screen_share_publish_options(): TrackPublishOptions {
    if (electron_bridge?.get_remote_control_supported?.() === true) {
        return {name: CONTROLLABLE_SCREEN_SHARE_TRACK_NAME};
    }
    return {};
}

export function is_controllable_screen_share(publication: TrackPublication): boolean {
    return publication.trackName === CONTROLLABLE_SCREEN_SHARE_TRACK_NAME;
}
