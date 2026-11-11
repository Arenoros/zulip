import * as z from "zod/mini";

// Sync this with LIVEKIT_RING_TIMEOUT in zerver/actions/video_calls.py.
export const RING_TIMEOUT_SECONDS = 45;

export const call_ring_schema = z.object({
    user_id: z.number(),
    caller_id: z.number(),
    date_rang: z.number(),
    answer: z.nullable(z.enum(["accept", "decline", "cancel"])),
});
export type CallRing = z.infer<typeof call_ring_schema>;

// Sync this with LiveKitCallConversation in zerver/openapi/zulip.yaml.
export const call_conversation_schema = z.object({
    message_id: z.number(),
    stream_id: z.optional(z.number()),
    topic: z.optional(z.string()),
    user_ids: z.optional(z.array(z.number())),
});
export type CallConversation = z.infer<typeof call_conversation_schema>;

export type InvitedUser = {user_id: number; status: "calling" | "declined" | "missed"};

// The people called to join the call who have not joined it, with how
// their latest call went.
export function get_invited_users(
    rings: CallRing[],
    joined_user_ids: ReadonlySet<number>,
    now_seconds: number,
): InvitedUser[] {
    const latest_rings = new Map<number, CallRing>();
    for (const ring of rings) {
        latest_rings.set(ring.user_id, ring);
    }
    const invited_users: InvitedUser[] = [];
    for (const ring of latest_rings.values()) {
        if (joined_user_ids.has(ring.user_id)) {
            continue;
        }
        let status: InvitedUser["status"];
        if (ring.answer === "decline") {
            status = "declined";
        } else if (
            ring.answer === "cancel" ||
            now_seconds >= ring.date_rang + RING_TIMEOUT_SECONDS
        ) {
            status = "missed";
        } else {
            // Someone who accepted shows as being called until they join.
            status = "calling";
        }
        invited_users.push({user_id: ring.user_id, status});
    }
    return invited_users;
}
