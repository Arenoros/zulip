import secrets

from django.db import transaction
from django.utils.translation import gettext as _

from zerver.actions.video_calls import check_livekit_is_call_provider, check_start_livekit_call
from zerver.lib.calendar.changes import get_or_create_calendar_event_chat
from zerver.lib.exceptions import JsonableError
from zerver.lib.streams import access_stream_by_id
from zerver.models import CalendarAttendee, CalendarEvent, Client, LiveKitCall, Stream, UserProfile

# The call of a meeting takes place in the meeting's chat, and is
# started by whoever joins it first.


def is_calendar_event_attendee(user_profile: UserProfile, event: CalendarEvent) -> bool:
    return CalendarAttendee.objects.filter(event=event, user=user_profile).exists()


def can_join_calendar_event_call(user_profile: UserProfile, event: CalendarEvent) -> bool:
    """The people in the meeting's chat: its attendees, and people
    removed from the meeting, who stay in the chat."""
    if is_calendar_event_attendee(user_profile, event):
        return True
    if event.chat_id is None:
        return False
    try:
        access_stream_by_id(user_profile, event.chat_id)
    except JsonableError:
        return False
    return True


def access_calendar_event_call(user_profile: UserProfile, event_id: int) -> CalendarEvent:
    event = (
        CalendarEvent.objects.filter(id=event_id, realm_id=user_profile.realm_id)
        .select_related("realm", "chat")
        .first()
    )
    if event is None or not can_join_calendar_event_call(user_profile, event):
        raise JsonableError(_("Invalid calendar event ID"))
    return event


def check_calendar_event_call(event: CalendarEvent) -> None:
    if event.is_cancelled:
        raise JsonableError(_("This event was cancelled"))
    if not event.has_zulip_call:
        raise JsonableError(_("This event has no Zulip call"))
    check_livekit_is_call_provider(event.realm)


def get_calendar_event_call(chat: Stream) -> LiveKitCall | None:
    assert chat.recipient_id is not None
    return (
        LiveKitCall.objects.filter(message__recipient_id=chat.recipient_id, date_ended=None)
        .order_by("-id")
        .first()
    )


def get_calendar_event_call_url(call: LiveKitCall, voice_only: bool) -> str:
    # Meeting calls are video calls; joining without video is up to
    # each person.
    return f"{call.url}&voice_only=true" if voice_only else call.url


def get_calendar_event_call_chat(user_profile: UserProfile, event: CalendarEvent) -> Stream:
    """The chat of the meeting, for someone who can join its call.
    Attendees who left the chat join it again."""
    if is_calendar_event_attendee(user_profile, event):
        return get_or_create_calendar_event_chat(user_profile, event.id)
    assert event.chat is not None
    return event.chat


@transaction.atomic(durable=True)
def get_or_start_calendar_event_call(
    user_profile: UserProfile, client: Client, event_id: int, chat: Stream
) -> LiveKitCall:
    # Locked, so that people joining at once join the same call.
    event = (
        CalendarEvent.objects.select_for_update(no_key=True)
        .select_related("realm")
        .get(id=event_id)
    )
    check_calendar_event_call(event)
    call = get_calendar_event_call(chat)
    if call is not None:
        return call
    message_id = check_start_livekit_call(
        user_profile,
        client,
        "stream",
        [chat.id],
        "",
        # The room of a call in a channel is named after the channel
        # and this ID, so it only needs to differ from the channel's
        # other calls.
        call_id=secrets.randbelow(2**53),
        voice_only=False,
        read_by_sender=client.default_read_by_sender(),
    )
    return LiveKitCall.objects.get(message_id=message_id)


def join_calendar_event_call(
    user_profile: UserProfile, client: Client, event: CalendarEvent, voice_only: bool
) -> str:
    """The link to the meeting's call, which is started if it is not
    taking place."""
    check_calendar_event_call(event)
    chat = get_calendar_event_call_chat(user_profile, event)
    call = get_or_start_calendar_event_call(user_profile, client, event.id, chat)
    return get_calendar_event_call_url(call, voice_only)
