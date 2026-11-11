import {$} from "jquery";
import assert from "minimalistic-assert";
import * as z from "zod/mini";

import * as browser_history from "./browser_history.ts";
import {Filter} from "./filter.ts";
import * as hash_util from "./hash_util.ts";
import * as narrow_state from "./narrow_state.ts";
import * as people from "./people.ts";
import * as unread from "./unread.ts";
import * as unread_ui from "./unread_ui.ts";
import * as util from "./util.ts";

// The web app can be the chat of a LiveKit call, in a frame of the
// call window. It then only shows the call chat, and opens other
// conversations in a new tab.

// Sync with livekit_call.ts.
const FRAME_NAME = "zulip-call-chat";

type Conversation =
    {type: "private"; user_ids_string: string} | {type: "stream"; stream_id: number; topic: string};

const call_window_message_schema = z.discriminatedUnion("type", [
    z.object({type: z.literal("show_call_chat"), hash: z.string()}),
    z.object({type: z.literal("focus_compose")}),
]);

let call_chat: Conversation | undefined;
let call_chat_hash = "";
let posted_unread_count: number | undefined;

export function is_active(): boolean {
    return call_chat !== undefined;
}

function get_conversation(filter: Filter): Conversation | undefined {
    if (!filter.is_conversation_view()) {
        return undefined;
    }
    const user_ids = narrow_state.pm_ids(filter);
    if (user_ids !== undefined) {
        return {type: "private", user_ids_string: people.pm_lookup_key_from_user_ids(user_ids)};
    }
    const stream_id = narrow_state.stream_id(filter, true);
    const topic = narrow_state.topic(filter);
    if (stream_id === undefined || topic === undefined) {
        return undefined;
    }
    return {type: "stream", stream_id, topic};
}

function get_hash_conversation(hash: string): Conversation | undefined {
    if (!hash.startsWith("#narrow/")) {
        return undefined;
    }
    let terms;
    try {
        terms = hash_util.parse_narrow(hash.split("/"));
    } catch {
        return undefined;
    }
    return terms === undefined ? undefined : get_conversation(new Filter(terms));
}

function is_call_chat_conversation(conversation: Conversation | undefined): boolean {
    assert(call_chat !== undefined);
    if (conversation === undefined) {
        return false;
    }
    if (call_chat.type === "private" || conversation.type === "private") {
        return (
            call_chat.type === "private" &&
            conversation.type === "private" &&
            call_chat.user_ids_string === conversation.user_ids_string
        );
    }
    return (
        call_chat.stream_id === conversation.stream_id &&
        util.lower_same(call_chat.topic, conversation.topic)
    );
}

export function is_call_chat(filter: Filter): boolean {
    return is_call_chat_conversation(get_conversation(filter));
}

export function is_call_chat_hash(hash: string): boolean {
    return is_call_chat_conversation(get_hash_conversation(hash));
}

export function is_call_chat_recipient(opts: {
    message_type: "private" | "stream";
    stream_id?: number | undefined;
    topic: string;
    private_message_recipient_ids: number[];
}): boolean {
    if (opts.message_type === "private") {
        return is_call_chat_conversation({
            type: "private",
            user_ids_string: people.pm_lookup_key_from_user_ids(opts.private_message_recipient_ids),
        });
    }
    return (
        opts.stream_id !== undefined &&
        is_call_chat_conversation({type: "stream", stream_id: opts.stream_id, topic: opts.topic})
    );
}

function open_in_new_tab(hash: string): void {
    window.open(browser_history.get_full_url(hash), "_blank", "noopener,noreferrer");
}

export function open_recipient_in_new_tab(opts: {
    message_type: "private" | "stream";
    stream_id?: number | undefined;
    topic: string;
    private_message_recipient_ids: number[];
}): void {
    if (opts.message_type === "private" && opts.private_message_recipient_ids.length > 0) {
        open_in_new_tab(hash_util.pm_with_url(opts.private_message_recipient_ids.join(",")));
    } else if (opts.message_type === "stream" && opts.stream_id !== undefined) {
        open_in_new_tab(hash_util.by_stream_topic_url(opts.stream_id, opts.topic));
    }
}

export function restore_call_chat_hash(old_hash: string | undefined): void {
    // Other views and overlays stay in the main web app, so the frame
    // returns to the call chat.
    const hash = old_hash !== undefined && is_call_chat_hash(old_hash) ? old_hash : call_chat_hash;
    window.history.replaceState(window.history.state, "", hash);
    browser_history.save_old_hash();
}

function get_unread_count(): number {
    assert(call_chat !== undefined);
    if (call_chat.type === "private") {
        return unread.num_unread_for_user_ids_string(call_chat.user_ids_string);
    }
    return unread.num_unread_for_topic(call_chat.stream_id, call_chat.topic);
}

function post_unread_count(): void {
    const count = get_unread_count();
    if (count === posted_unread_count) {
        return;
    }
    posted_unread_count = count;
    window.parent.postMessage({type: "call_chat_unread_count", count}, window.location.origin);
}

function is_framed_by_same_origin(): boolean {
    if (window.parent === window) {
        return false;
    }
    try {
        return window.parent.location.origin === window.location.origin;
    } catch {
        // Reading the location of a page from another origin throws.
        return false;
    }
}

function on_call_window_message(event: MessageEvent): void {
    if (event.origin !== window.location.origin || event.source !== window.parent) {
        return;
    }
    const message = call_window_message_schema.parse(event.data);
    switch (message.type) {
        case "show_call_chat": {
            const conversation = get_hash_conversation(message.hash);
            if (conversation === undefined) {
                return;
            }
            call_chat = conversation;
            call_chat_hash = message.hash;
            browser_history.go_to_location(message.hash);
            post_unread_count();
            break;
        }
        case "focus_compose":
            $("textarea#compose-textarea").trigger("focus");
            break;
    }
}

function on_link_click(event: MouseEvent): void {
    if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof Element)
    ) {
        return;
    }
    const link = event.target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) {
        return;
    }
    const url = new URL(link.href);
    if (
        url.origin !== window.location.origin ||
        url.pathname !== window.location.pathname ||
        url.hash === "" ||
        is_call_chat_hash(url.hash)
    ) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    open_in_new_tab(url.hash);
}

export function initialize(): void {
    if (window.name !== FRAME_NAME || !is_framed_by_same_origin()) {
        return;
    }
    call_chat = get_hash_conversation(window.location.hash);
    if (call_chat === undefined) {
        return;
    }
    call_chat_hash = window.location.hash;
    $("body").addClass("embedded-call-chat");
    window.addEventListener("message", on_call_window_message);
    document.addEventListener("click", on_link_click, {capture: true});
    unread_ui.register_update_unread_counts_hook(post_unread_count);
    post_unread_count();
}
