import secrets

from django.db import transaction
from django.utils.translation import gettext as _

from zerver.actions.video_calls import check_livekit_is_call_provider, check_start_livekit_call
from zerver.lib.calendar.changes import get_or_create_calendar_event_chat
from zerver.lib.exceptions import JsonableError
from zerver.lib.streams import access_stream_by_id
from zerver.lib.topic import messages_for_topic
from zerver.models import CalendarAttendee, CalendarEvent, Client, LiveKitCall, Stream, UserProfile

# The call of a meeting takes place in the meeting's chat, or for a
# meeting in a channel, in its topic, and is started by whoever joins
# it first.


def is_calendar_event_attendee(user_profile: UserProfile, event: CalendarEvent) -> bool:
    return CalendarAttendee.objects.filter(event=event, user=user_profile).exists()


def can_access_channel(user_profile: UserProfile, channel_id: int) -> bool:
    try:
        access_stream_by_id(user_profile, channel_id)
    except JsonableError:
        return False
    return True


def can_join_calendar_event_call(user_profile: UserProfile, event: CalendarEvent) -> bool:
    """The attendees, and the people in the meeting's chat, who include
    people removed from the meeting, or those who can access the
    channel of a meeting in a channel."""
    if is_calendar_event_attendee(user_profile, event):
        return True
    channel_id = event.channel_id or event.chat_id
    return channel_id is not None and can_access_channel(user_profile, channel_id)


def get_attended_channel_meeting(
    user_profile: UserProfile, call: LiveKitCall
) -> CalendarEvent | None:
    """The meeting in a channel, that the user is invited to, whose
    call this is; attendees who cannot access the channel join its call
    too."""
    message = call.message
    return CalendarEvent.objects.filter(
        channel__recipient_id=message.recipient_id,
        topic__iexact=message.topic_name(),
        calendarattendee__user=user_profile,
    ).first()


def access_calendar_event_call(user_profile: UserProfile, event_id: int) -> CalendarEvent:
    event = (
        CalendarEvent.objects.filter(id=event_id, realm_id=user_profile.realm_id)
        .select_related("realm", "chat", "channel")
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


def get_calendar_event_call_place(event: CalendarEvent) -> tuple[Stream, str] | None:
    """The channel and topic where the meeting's call takes place, if
    it has a chat or a channel."""
    if event.channel is not None:
        return event.channel, event.topic
    if event.chat is not None:
        return event.chat, ""
    return None


def get_calendar_event_call(event: CalendarEvent) -> LiveKitCall | None:
    place = get_calendar_event_call_place(event)
    if place is None:
        return None
    stream, topic = place
    assert stream.recipient_id is not None
    return (
        LiveKitCall.objects.filter(
            message__in=messages_for_topic(stream.realm_id, stream.recipient_id, topic),
            date_ended=None,
        )
        .order_by("-id")
        .first()
    )


def get_calendar_event_call_url(call: LiveKitCall, voice_only: bool) -> str:
    # Meeting calls are video calls; joining without video is up to
    # each person.
    return f"{call.url}&voice_only=true" if voice_only else call.url


def get_calendar_event_call_chat(user_profile: UserProfile, event: CalendarEvent) -> None:
    """Creates the chat of the meeting, for someone who can join its
    call, if it has none; attendees who left the chat join it again.
    A meeting in a channel has its channel instead."""
    if event.channel_id is None and is_calendar_event_attendee(user_profile, event):
        get_or_create_calendar_event_chat(user_profile, event.id)


@transaction.atomic(durable=True)
def get_or_start_calendar_event_call(
    user_profile: UserProfile, client: Client, event_id: int
) -> LiveKitCall:
    # Locked, so that people joining at once join the same call.
    event = (
        CalendarEvent.objects.select_for_update(no_key=True)
        .select_related("realm")
        .get(id=event_id)
    )
    check_calendar_event_call(event)
    call = get_calendar_event_call(event)
    if call is not None:
        return call
    if event.channel_id is not None and not can_access_channel(user_profile, event.channel_id):
        # The call is started by a message in the channel, which only
        # people in the channel can send.
        raise JsonableError(
            _("The call has not started yet. Someone in the channel will start it.")
        )
    place = get_calendar_event_call_place(event)
    assert place is not None
    stream, topic = place
    message_id = check_start_livekit_call(
        user_profile,
        client,
        "stream",
        [stream.id],
        topic,
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
    get_calendar_event_call_chat(user_profile, event)
    call = get_or_start_calendar_event_call(user_profile, client, event.id)
    return get_calendar_event_call_url(call, voice_only)
