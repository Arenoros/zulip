from collections.abc import Collection, Iterable
from datetime import timedelta
from typing import Literal

from django.db import transaction
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _
from django.utils.translation import override as override_language

from zerver.actions.message_send import check_can_send_direct_message, check_send_message
from zerver.lib.event_types import (
    BaseEvent,
    CallAnswerEvent,
    CallCancelEvent,
    CallRing,
    CallRingEvent,
    CallRingsEvent,
    HasGoogleMeetTokenEvent,
    HasWebexTokenEvent,
    HasZoomTokenEvent,
)
from zerver.lib.exceptions import JsonableError
from zerver.lib.muted_users import get_muting_users
from zerver.lib.recipient_users import (
    check_sender_can_access_recipients,
    recipient_for_user_profiles,
)
from zerver.lib.streams import subscribed_to_stream, user_has_content_access
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.lib.user_groups import UserGroupMembershipDetails
from zerver.models import (
    Client,
    LiveKitCall,
    LiveKitCallParticipant,
    LiveKitCallRing,
    Realm,
    Stream,
    UserProfile,
)
from zerver.tornado.django_api import send_event_on_commit


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


# Sync this with RING_TIMEOUT_MS in call_ringing.ts.
LIVEKIT_RING_TIMEOUT = timedelta(seconds=45)

LIVEKIT_RING_ANSWERS: dict[int, Literal["accept", "decline", "cancel"]] = {
    LiveKitCallRing.ACCEPTED: "accept",
    LiveKitCallRing.DECLINED: "decline",
    LiveKitCallRing.CANCELLED: "cancel",
}


def get_livekit_call_rings(call: LiveKitCall) -> list[CallRing]:
    return [
        CallRing(
            user_id=ring.user_profile_id,
            caller_id=ring.caller_id,
            date_rang=datetime_to_timestamp(ring.date_rang),
            answer=None if ring.answer is None else LIVEKIT_RING_ANSWERS[ring.answer],
        )
        for ring in LiveKitCallRing.objects.filter(call=call).order_by("id")
    ]


def send_livekit_call_rings_event(
    realm: Realm, call: LiveKitCall, caller_ids: Iterable[int]
) -> None:
    # Everyone in the call, and whoever called people to it, shows who
    # is being called.
    user_ids = set(caller_ids) | set(
        LiveKitCallParticipant.objects.filter(call=call, in_call=True).values_list(
            "user_profile_id", flat=True
        )
    )
    event = CallRingsEvent(message_id=call.message_id, rings=get_livekit_call_rings(call))
    send_event_on_commit(realm, event, user_ids)


def ring_livekit_call(caller: UserProfile, call: LiveKitCall, user_ids: Iterable[int]) -> None:
    called_user_ids = list(
        UserProfile.objects.filter(
            id__in=user_ids, realm_id=caller.realm_id, is_active=True, is_bot=False
        )
        .exclude(id=caller.id)
        .values_list("id", flat=True)
    )
    now = timezone_now()
    LiveKitCallRing.objects.bulk_create(
        LiveKitCallRing(call=call, user_profile_id=user_id, caller=caller, date_rang=now)
        for user_id in called_user_ids
    )
    # People who muted the caller are not rung, but are still shown as
    # being called, so that the caller cannot tell.
    muting_user_ids = get_muting_users(caller.id)
    event = CallRingEvent(
        message_id=call.message_id, caller_id=caller.id, url=call.url, voice_only=call.voice_only
    )
    send_event_on_commit(
        caller.realm,
        event,
        [user_id for user_id in called_user_ids if user_id not in muting_user_ids],
    )
    send_livekit_call_rings_event(caller.realm, call, [caller.id])


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
        room = get_livekit_call_room(caller.realm, call_id, dm_user_ids=user_ids)
    else:
        url += f"&channel_id={message_to[0]}"
        room = get_livekit_call_room(caller.realm, call_id, channel_id=message_to[0])
    if LiveKitCall.objects.filter(room=room).exists():
        raise JsonableError(_("This call has already been started."))
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
    call = LiveKitCall.objects.create(
        room=room, message_id=message_id, url=url, voice_only=voice_only
    )

    # Like channel meetings in other chat apps, a call in a channel
    # only posts its link; only direct message calls ring.
    if recipient_type_name == "private":
        ring_livekit_call(caller, call, message_to)

    return message_id


@transaction.atomic(durable=True)
def do_end_livekit_call(room: str) -> None:
    call = (
        LiveKitCall.objects.select_for_update(no_key=True, of=("self",))
        .select_related("message__realm", "message__recipient")
        .filter(room=room, date_ended=None)
        .first()
    )
    if call is None:
        return
    call.date_ended = timezone_now()
    call.save(update_fields=["date_ended"])
    LiveKitCallParticipant.objects.filter(call=call).update(in_call=False)

    # A call that ends while it is still ringing stops ringing, for its
    # callers too.
    unanswered_rings = list(LiveKitCallRing.objects.filter(call=call, answer=None))
    user_ids = {ring.user_profile_id for ring in unanswered_rings} | {
        ring.caller_id for ring in unanswered_rings
    }
    if user_ids:
        event = CallCancelEvent(message_id=call.message_id)
        send_event_on_commit(call.message.realm, event, user_ids)


def check_invite_to_livekit_call(
    inviter: UserProfile, call: LiveKitCall, invitees: list[UserProfile]
) -> None:
    if call.date_ended is not None:
        raise JsonableError(_("This call has ended."))
    if call.message.is_channel_message:
        stream = Stream.objects.get(id=call.message.recipient.type_id)
        for invitee in invitees:
            if not user_has_content_access(
                invitee,
                stream,
                UserGroupMembershipDetails(user_recursive_group_ids=None),
                is_subscribed=subscribed_to_stream(invitee, stream.id),
            ):
                raise JsonableError(
                    _("{full_name} cannot access this channel.").format(full_name=invitee.full_name)
                )
    # Calling someone is a way of contacting them, so it follows the
    # same rules as direct messages.
    for invitee in invitees:
        check_sender_can_access_recipients(inviter, [invitee])
        recipient = recipient_for_user_profiles([invitee], None, inviter)
        check_can_send_direct_message(inviter.realm, inviter, [invitee], recipient)
    ring_livekit_call(inviter, call, [invitee.id for invitee in invitees])


def do_update_livekit_call_participant(room: str, identity: str, in_call: bool) -> None:
    call = LiveKitCall.objects.select_related("message").filter(room=room).first()
    # Participants are identified by their user ID; see join_livekit_call.
    if call is None or not identity.isdecimal():
        return
    user_profile = UserProfile.objects.filter(
        id=int(identity), realm_id=call.message.realm_id
    ).first()
    if user_profile is None:
        return
    LiveKitCallParticipant.objects.update_or_create(
        call=call, user_profile=user_profile, defaults={"in_call": in_call}
    )


@transaction.atomic(durable=True)
def do_answer_call(
    user_profile: UserProfile, ring: LiveKitCallRing, operator: Literal["accept", "decline"]
) -> None:
    ring.answer = LiveKitCallRing.ACCEPTED if operator == "accept" else LiveKitCallRing.DECLINED
    ring.save(update_fields=["answer"])
    # The user's other clients stop ringing too.
    event = CallAnswerEvent(op=operator, message_id=ring.call.message_id, user_id=user_profile.id)
    send_event_on_commit(user_profile.realm, event, [ring.caller_id, user_profile.id])
    send_livekit_call_rings_event(user_profile.realm, ring.call, [ring.caller_id])


@transaction.atomic(durable=True)
def do_cancel_call(caller: UserProfile, call: LiveKitCall) -> None:
    rings = LiveKitCallRing.objects.filter(call=call, caller=caller, answer=None)
    user_ids = [ring.user_profile_id for ring in rings]
    rings.update(answer=LiveKitCallRing.CANCELLED)
    event = CallCancelEvent(message_id=call.message_id)
    send_event_on_commit(caller.realm, event, user_ids)
    send_livekit_call_rings_event(caller.realm, call, [caller.id])
