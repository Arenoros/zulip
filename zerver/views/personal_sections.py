from django.http import HttpRequest, HttpResponse
from pydantic import Json

from zerver.actions.personal_sections import do_update_personal_sections
from zerver.lib.personal_sections import (
    PersonalConversationSection,
    check_personal_conversation_sections,
)
from zerver.lib.response import json_success
from zerver.lib.typed_endpoint import typed_endpoint
from zerver.models import UserProfile


@typed_endpoint
def update_personal_sections(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    conversation_sections: Json[list[PersonalConversationSection]],
) -> HttpResponse:
    check_personal_conversation_sections(conversation_sections)
    do_update_personal_sections(user_profile, conversation_sections)
    return json_success(request)
