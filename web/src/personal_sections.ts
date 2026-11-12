import * as people from "./people.ts";
import type {StateData} from "./state_data.ts";
import * as util from "./util.ts";

type PersonalSections = StateData["personal_sections"]["personal_sections"];
export type ConversationSection = PersonalSections["conversation_sections"][number];

export const MAX_SECTION_NAME_LENGTH = 60;

let conversation_sections: ConversationSection[] = [];

export function set_personal_sections(personal_sections: PersonalSections): void {
    conversation_sections = personal_sections.conversation_sections;
}

export function initialize(params: StateData["personal_sections"]): void {
    set_personal_sections(params.personal_sections);
}

function user_ids_string_from_conversation(user_ids: number[]): string {
    // The server leaves the current user out of a conversation, while
    // a user_ids_string has them for the conversation with oneself.
    return people.pm_lookup_key_from_user_ids(user_ids);
}

function conversation_from_user_ids_string(user_ids_string: string): number[] {
    const user_ids = people.user_ids_string_to_ids_array(user_ids_string);
    return util.sorted_ids(user_ids.filter((user_id) => !people.is_my_user_id(user_id)));
}

export function get_conversation_sections(): {name: string; user_ids_strings: string[]}[] {
    return conversation_sections.map((section) => ({
        name: section.name,
        user_ids_strings: section.conversations.map((user_ids) =>
            user_ids_string_from_conversation(user_ids),
        ),
    }));
}

export function get_conversation_section_name(user_ids_string: string): string | undefined {
    return get_conversation_sections().find((section) =>
        section.user_ids_strings.includes(user_ids_string),
    )?.name;
}

// The functions below return the user's sections of conversations
// with a change made to them, for sending to the server; the sections
// change here only when the server reports that it stored them.

function without_conversation(user_ids_string: string): ConversationSection[] {
    return conversation_sections.map((section) => ({
        name: section.name,
        conversations: section.conversations.filter(
            (user_ids) => user_ids_string_from_conversation(user_ids) !== user_ids_string,
        ),
    }));
}

export function with_conversation_moved(
    user_ids_string: string,
    section_name: string | undefined,
): ConversationSection[] {
    return without_conversation(user_ids_string).map((section) =>
        section.name === section_name
            ? {
                  name: section.name,
                  conversations: [
                      ...section.conversations,
                      conversation_from_user_ids_string(user_ids_string),
                  ],
              }
            : section,
    );
}

export function with_conversation_section_added(
    section_name: string,
    user_ids_string: string,
): ConversationSection[] {
    return [
        ...without_conversation(user_ids_string),
        {
            name: section_name,
            conversations: [conversation_from_user_ids_string(user_ids_string)],
        },
    ];
}

export function with_conversation_section_renamed(
    section_name: string,
    new_section_name: string,
): ConversationSection[] {
    return conversation_sections.map((section) =>
        section.name === section_name ? {...section, name: new_section_name} : section,
    );
}

export function with_conversation_section_removed(section_name: string): ConversationSection[] {
    return conversation_sections.filter((section) => section.name !== section_name);
}
