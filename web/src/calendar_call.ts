import * as z from "zod/mini";

import * as call_ringing from "./call_ringing.ts";
import * as channel from "./channel.ts";
import * as compose_call from "./compose_call.ts";
import {$t_html} from "./i18n.ts";
import * as ui_report from "./ui_report.ts";

// The call of a meeting with a Zulip call takes place in the meeting's
// chat; joining it starts it if it is not taking place.

export function can_join(occurrence: {has_zulip_call: boolean; is_cancelled: boolean}): boolean {
    return (
        occurrence.has_zulip_call &&
        !occurrence.is_cancelled &&
        compose_call.is_livekit_call_provider()
    );
}

function post_join(
    event_id: number,
    voice_only: boolean,
    call_window: ReturnType<typeof call_ringing.open_window_for_new_call>,
    on_error: (xhr: JQuery.jqXHR) => void,
): void {
    void channel.post({
        url: `/json/calendar/events/${event_id}/call`,
        data: {voice_only: JSON.stringify(voice_only)},
        success(data) {
            call_window.show(z.object({url: z.string()}).parse(data).url);
        },
        error(xhr) {
            call_window.close();
            on_error(xhr);
        },
    });
}

// Must be called in response to a click, which lets the call's
// window open.
export function join(event_id: number, voice_only: boolean, $error: JQuery): void {
    post_join(event_id, voice_only, call_ringing.open_window_for_new_call(), (xhr) => {
        ui_report.error($t_html({defaultMessage: "Failed to join the call"}), xhr, $error);
    });
}
