import * as z from "zod/mini";

import * as channel from "./channel.ts";
import type {Filter} from "./filter.ts";
import {call_conversation_schema} from "./livekit_call_invites.ts";
import type {CallConversation} from "./livekit_call_invites.ts";
import * as narrow_state from "./narrow_state.ts";
import {page_params} from "./page_params.ts";
import * as people from "./people.ts";
import {get_topic_key} from "./recent_view_util.ts";
import {realm} from "./state_data.ts";

const missed_call_schema = z.object({
    caller_id: z.number(),
    date_rang: z.number(),
    seen: z.boolean(),
    conversation: call_conversation_schema,
});
export type MissedCall = z.infer<typeof missed_call_schema>;

let missed_calls: MissedCall[] = [];
let on_change = (): void => {
    // Set in initialize.
};

// Only LiveKit calls ring people, so only they can be missed.
export function is_available(): boolean {
    return (
        !page_params.is_spectator &&
        realm.realm_available_video_chat_providers.livekit !== undefined
    );
}

// The Recent conversations key of the conversation with the call.
export function get_conversation_key(conversation: CallConversation): string {
    if (conversation.stream_id !== undefined && conversation.topic !== undefined) {
        return get_topic_key(conversation.stream_id, conversation.topic);
    }
    return people.sorted_other_user_ids(conversation.user_ids ?? []).join(",");
}

export function get_counts(conversation_key: string): {count: number; unseen_count: number} {
    const conversation_calls = missed_calls.filter(
        (missed_call) => get_conversation_key(missed_call.conversation) === conversation_key,
    );
    return {
        count: conversation_calls.length,
        unseen_count: conversation_calls.filter((missed_call) => !missed_call.seen).length,
    };
}

export function get_unseen_count(): number {
    return missed_calls.filter((missed_call) => !missed_call.seen).length;
}

export function add(missed_call: MissedCall): void {
    missed_calls.unshift(missed_call);
    on_change();
}

export function mark_seen(message_ids: number[]): void {
    for (const missed_call of missed_calls) {
        if (message_ids.includes(missed_call.conversation.message_id)) {
            missed_call.seen = true;
        }
    }
    on_change();
}

// Opening a conversation marks the calls missed in it as seen.
export function handle_narrow_activated(filter: Filter): void {
    let conversation_key: string | undefined;
    const stream_id = narrow_state.stream_id(filter);
    const topic = narrow_state.topic(filter);
    const dm_user_ids = narrow_state.pm_ids(filter);
    if (stream_id !== undefined && topic !== undefined) {
        conversation_key = get_topic_key(stream_id, topic);
    } else if (dm_user_ids !== undefined) {
        conversation_key = people.sorted_other_user_ids(dm_user_ids).join(",");
    }
    const message_ids = missed_calls
        .filter(
            (missed_call) =>
                !missed_call.seen &&
                get_conversation_key(missed_call.conversation) === conversation_key,
        )
        .map((missed_call) => missed_call.conversation.message_id);
    if (message_ids.length === 0) {
        return;
    }
    mark_seen(message_ids);
    void channel.post({
        url: "/json/calls/livekit/missed/seen",
        data: {message_ids: JSON.stringify(message_ids)},
    });
}

export function initialize(opts: {on_change: () => void}): void {
    on_change = opts.on_change;
    void channel.get({
        url: "/json/calls/livekit/missed",
        success(data) {
            missed_calls = z
                .object({missed_calls: z.array(missed_call_schema)})
                .parse(data).missed_calls;
            on_change();
        },
    });
}
