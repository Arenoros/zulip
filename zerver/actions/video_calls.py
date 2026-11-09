from collections.abc import Collection
from typing import Literal

from django.db import transaction
from django.utils.translation import gettext as _
from django.utils.translation import override as override_language

from zerver.actions.message_send import check_send_message
from zerver.lib.event_types import (
    BaseEvent,
    CallAnswerEvent,
    CallCancelEvent,
    CallRingEvent,
    HasGoogleMeetTokenEvent,
    HasWebexTokenEvent,
    HasZoomTokenEvent,
)
from zerver.lib.muted_users import get_muting_users
from zerver.models import Client, Message, Realm, UserMessage, UserProfile
from zerver.tornado.django_api import send_event_on_commit, send_event_rollback_unsafe


@transaction.atomic(durable=True)
def do_set_video_call_provider_token(
    user: UserProfile,
    token_key: Literal["google_meet", "webex", "zoom"],
    /,
    token: dict[str, object] | None,
) -> None:
    user.third_party_api_state[token_key] = token
    user.save(update_fields=["third_party_api_state"])
    event: BaseEvent
    if token_key == "google_meet":
        event = HasGoogleMeetTokenEvent(value=token is not None)
    elif token_key == "webex":
        event = HasWebexTokenEvent(value=token is not None)
    else:
        event = HasZoomTokenEvent(value=token is not None)
    send_event_on_commit(user.realm, event, [user.id])


def get_livekit_call_room(
    realm: Realm,
    call_id: int,
    *,
    dm_user_ids: Collection[int] | None = None,
    channel_id: int | None = None,
) -> str:
    # Rooms are scoped to the organization of the user opening the
    # link, so that a link can never join users of different
    # organizations, even ones on other Zulip servers sharing the
    # LiveKit server. A call started in a conversation has a room of
    # its own, named after the conversation.
    if dm_user_ids is not None:
        user_ids = ",".join(str(user_id) for user_id in sorted(set(dm_user_ids)))
        return f"{realm.uuid}-dm-{user_ids}-{call_id}"
    if channel_id is not None:
        return f"{realm.uuid}-channel-{channel_id}-{call_id}"
    return f"{realm.uuid}-{call_id}"


def check_start_livekit_call(
    caller: UserProfile,
    client: Client,
    recipient_type_name: Literal["private", "stream"],
    message_to: list[int],
    topic_name: str | None,
    *,
    call_id: int,
    voice_only: bool,
    read_by_sender: bool,
) -> int:
    # The link names the conversation, so that join_livekit_call only
    # admits the people in it.
    url = f"/calls/livekit/join?call_id={call_id}"
    if recipient_type_name == "private":
        user_ids = sorted({*message_to, caller.id})
        url += "&dm=" + ",".join(str(user_id) for user_id in user_ids)
    else:
        url += f"&channel_id={message_to[0]}"
    if voice_only:
        url += "&voice_only=true"
    with override_language(caller.default_language):
        link_text = _("Join voice call.") if voice_only else _("Join video call.")
    message_id = check_send_message(
        caller,
        client,
        recipient_type_name,
        message_to,
        topic_name,
        f"[{link_text}]({url})",
        read_by_sender=read_by_sender,
    ).message_id

    # Like channel meetings in other chat apps, a call in a channel
    # only posts its link; only direct message calls ring.
    if recipient_type_name == "private":
        muting_user_ids = get_muting_users(caller.id)
        ring_user_ids = [
            user_id
            for user_id in UserProfile.objects.filter(
                id__in=message_to, realm_id=caller.realm_id, is_active=True, is_bot=False
            ).values_list("id", flat=True)
            if user_id != caller.id and user_id not in muting_user_ids
        ]
        event = CallRingEvent(
            message_id=message_id, caller_id=caller.id, url=url, voice_only=voice_only
        )
        send_event_on_commit(caller.realm, event, ring_user_ids)

    return message_id


def do_answer_call(
    user_profile: UserProfile, message: Message, operator: Literal["accept", "decline"]
) -> None:
    # The user's other clients stop ringing too.
    event = CallAnswerEvent(op=operator, message_id=message.id, user_id=user_profile.id)
    send_event_rollback_unsafe(user_profile.realm, event, [message.sender_id, user_profile.id])


def do_cancel_call(caller: UserProfile, message: Message) -> None:
    recipient_user_ids = (
        UserMessage.objects.filter(message_id=message.id)
        .exclude(user_profile_id=caller.id)
        .values_list("user_profile_id", flat=True)
    )
    event = CallCancelEvent(message_id=message.id)
    send_event_rollback_unsafe(caller.realm, event, list(recipient_user_ids))
