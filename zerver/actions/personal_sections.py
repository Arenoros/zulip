from django.db import transaction

from zerver.lib.event_types import PersonalSectionsUpdateEvent
from zerver.lib.personal_sections import PersonalConversationSection
from zerver.models import PersonalSections, UserProfile
from zerver.tornado.django_api import send_event_on_commit


@transaction.atomic(durable=True)
def do_update_personal_sections(
    user_profile: UserProfile, conversation_sections: list[PersonalConversationSection]
) -> None:
    personal_sections, _created = PersonalSections.objects.update_or_create(
        user_profile=user_profile, defaults={"conversation_sections": conversation_sections}
    )
    event = PersonalSectionsUpdateEvent(
        conversation_sections=personal_sections.conversation_sections
    )
    send_event_on_commit(user_profile.realm, event, [user_profile.id])
