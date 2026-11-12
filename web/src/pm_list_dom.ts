import _ from "lodash";

import render_more_private_conversations from "../templates/more_pms.hbs";
import render_pm_list_item from "../templates/pm_list_item.hbs";
import render_pm_list_section_header from "../templates/pm_list_section_header.hbs";

import type {PMListConversation} from "./pm_list_data.ts";
import * as vdom from "./vdom.ts";

export type PMNode =
    | {
          type: "conversation";
          conversation: PMListConversation;
      }
    | {
          type: "more_items";
          more_conversations_unread_count: number;
      }
    | {
          type: "section_header";
          section_header: PMListSectionHeader;
      };

export type PMListSectionHeader = {
    name: string;
    // Whether this is one of the user's personal sections, rather
    // than the heading of the conversations outside of them.
    is_personal_section: boolean;
    is_collapsed: boolean;
    unread: number;
};

export function keyed_pm_li(conversation: PMListConversation): vdom.Node<PMNode> {
    const render = (): string => render_pm_list_item(conversation);

    const eq = (other: PMNode): boolean =>
        other.type === "conversation" && _.isEqual(conversation, other.conversation);

    const key = conversation.user_ids_string;

    return {
        key,
        render,
        eq,
        type: "conversation",
        conversation,
    };
}

export function more_private_conversations_li(
    more_conversations_unread_count: number,
): vdom.Node<PMNode> {
    const render = (): string =>
        render_more_private_conversations({more_conversations_unread_count});

    // Used in vdom.js to check if an element has changed and needs to
    // be updated in the DOM.
    const eq = (other: PMNode): boolean =>
        other.type === "more_items" &&
        more_conversations_unread_count === other.more_conversations_unread_count;

    // This special key must be impossible as a user_ids_string.
    const key = "more_private_conversations";

    return {
        key,
        render,
        eq,
        type: "more_items",
        more_conversations_unread_count,
    };
}

export function section_header_li(section_header: PMListSectionHeader): vdom.Node<PMNode> {
    const render = (): string =>
        render_pm_list_section_header({
            ...section_header,
            show_unread: section_header.is_collapsed && section_header.unread > 0,
        });

    const eq = (other: PMNode): boolean =>
        other.type === "section_header" && _.isEqual(section_header, other.section_header);

    // A user_ids_string has no colon, so this can't be the key of a
    // conversation.
    const key = section_header.is_personal_section
        ? `section:${section_header.name}`
        : "other_conversations";

    return {
        key,
        render,
        eq,
        type: "section_header",
        section_header,
    };
}

export function pm_ul(nodes: vdom.Node<PMNode>[]): vdom.Tag<PMNode> {
    const attrs: [string, string][] = [
        ["class", "dm-list"],
        ["data-name", "private"],
    ];
    return vdom.ul({
        attrs,
        keyed_nodes: nodes,
    });
}
