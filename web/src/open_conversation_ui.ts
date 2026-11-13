import $ from "jquery";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";

import * as clipboard_handler from "./clipboard_handler.ts";
import {$t_html} from "./i18n.ts";
import * as message_edit from "./message_edit.ts";
import {realm} from "./state_data.ts";
import * as stream_popover from "./stream_popover.ts";

function get_topic(element: HTMLElement): {stream_id: number; topic_name: string; url: string} {
    const $actions = $(element).closest(".open-conversation-header-actions");
    return {
        stream_id: Number.parseInt($actions.attr("data-stream-id")!, 10),
        topic_name: $actions.attr("data-topic-name")!,
        url: new URL($actions.attr("data-topic-url")!, realm.realm_url).href,
    };
}

export function initialize(): void {
    // The header of an open conversation offers the actions of the
    // topic's recipient bar.
    $("#message_view_header").on("click", ".open-conversation-resolve", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const {stream_id, topic_name} = get_topic(this);
        message_edit.with_first_message_id(stream_id, topic_name, (message_id) => {
            assert(message_id !== undefined);
            message_edit.toggle_resolve_topic(message_id, topic_name, true);
        });
    });

    $("#message_view_header").on("click", ".open-conversation-rename", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const {stream_id, topic_name} = get_topic(this);
        void stream_popover.build_move_topic_to_stream_popover(stream_id, topic_name, true);
    });

    $("#message_view_header").on("click", ".open-conversation-copy-link", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const {url} = get_topic(this);
        void (async () => {
            await clipboard_handler.copy_link_to_clipboard(url);
            const tippy_instance: tippy.Instance | undefined = (
                this as tippy.ReferenceElement
            )._tippy;
            if (tippy_instance) {
                tippy_instance.setContent($t_html({defaultMessage: "Copied!"}));
                tippy_instance.show();
                setTimeout(() => {
                    tippy_instance.hide();
                }, 1000);
            }
        })();
    });
}
