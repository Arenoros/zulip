from typing import Annotated

from django.utils.translation import gettext as _
from pydantic import AfterValidator, Field, StringConstraints
from typing_extensions import TypedDict

from zerver.lib.exceptions import JsonableError
from zerver.models import PersonalSections, UserProfile

SectionName = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=PersonalSections.MAX_SECTION_NAME_LENGTH, strip_whitespace=True
    ),
]


def check_user_ids_sorted_and_unique(user_ids: list[int]) -> list[int]:
    # A conversation has to be written in one way, so that it can't
    # be put into two sections.
    if user_ids != sorted(set(user_ids)):
        raise ValueError("user IDs must be unique and in ascending order")
    return user_ids


class PersonalConversationSection(TypedDict):
    name: SectionName
    # Each conversation is the IDs of its participants other than the
    # owner of the section, like in recent_private_conversations.
    conversations: list[
        Annotated[
            list[int],
            Field(max_length=PersonalSections.MAX_CONVERSATION_USERS),
            AfterValidator(check_user_ids_sorted_and_unique),
        ]
    ]


class PersonalSectionsDict(TypedDict):
    conversation_sections: list[PersonalConversationSection]


def check_personal_conversation_sections(sections: list[PersonalConversationSection]) -> None:
    names = [section["name"] for section in sections]
    items = [tuple(user_ids) for section in sections for user_ids in section["conversations"]]
    if len(names) > PersonalSections.MAX_SECTIONS:
        raise JsonableError(
            _("Too many sections (limit: {max_sections}).").format(
                max_sections=PersonalSections.MAX_SECTIONS
            )
        )
    if len({name.casefold() for name in names}) != len(names):
        raise JsonableError(_("Section names must be unique."))
    if len(items) > PersonalSections.MAX_ITEMS:
        raise JsonableError(
            _("Too many items in sections (limit: {max_items}).").format(
                max_items=PersonalSections.MAX_ITEMS
            )
        )
    if len(set(items)) != len(items):
        raise JsonableError(_("An item can only be in one section."))


def get_personal_sections(user_profile: UserProfile) -> PersonalSectionsDict:
    personal_sections = PersonalSections.objects.filter(user_profile=user_profile).first()
    if personal_sections is None:
        return PersonalSectionsDict(conversation_sections=[])
    return PersonalSectionsDict(
        conversation_sections=personal_sections.conversation_sections
    )
