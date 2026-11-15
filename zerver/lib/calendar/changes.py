import itertools
import secrets
import uuid
import zoneinfo
from collections import defaultdict
from datetime import datetime, time

from django.db import transaction
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _

from zerver.actions.streams import bulk_add_subscriptions, rename_stream_without_notice
from zerver.lib.calendar.occurrences import (
    access_calendar_event_by_id,
    get_unanswered_invitation_counts,
)
from zerver.lib.calendar.recurrence import is_occurrence_start, validate_rrule
from zerver.lib.event_types import CalendarChangeEvent, CalendarFreeBusyEvent
from zerver.lib.exceptions import JsonableError
from zerver.lib.streams import can_access_stream_metadata_user_ids, create_stream_if_needed
from zerver.lib.timezone import canonicalize_timezone
from zerver.lib.types import UNSET, Unset
from zerver.lib.user_groups import get_role_based_system_groups_dict
from zerver.models import (
    CalendarAttendee,
    CalendarAttendeeOccurrenceResponse,
    CalendarEvent,
    CalendarEventException,
    CalendarPinnedUser,
    CalendarUserSettings,
    Realm,
    Stream,
    UserProfile,
)
from zerver.models.calendar import DEFAULT_REMINDER_MINUTES, CalendarResponse, CalendarShowAs
from zerver.models.groups import SystemGroups
from zerver.models.streams import StreamTopicsPolicyEnum
from zerver.tornado.django_api import send_event_on_commit

# Outlook's default color categories, by the names Exchange stores.
CALENDAR_CATEGORIES = [
    "Red category",
    "Orange category",
    "Yellow category",
    "Green category",
    "Blue category",
    "Purple category",
]


def render_calendar_description(description: str, user_profile: UserProfile) -> str:
    from zerver.lib.markdown import markdown_convert

    return markdown_convert(
        description, message_realm=user_profile.realm, no_previews=True, acting_user=user_profile
    ).rendered_content


def check_calendar_event_time(
    start: datetime, end: datetime, event_timezone: str, is_all_day: bool
) -> str:
    """Returns the canonical name of the timezone."""
    try:
        event_timezone = canonicalize_timezone(event_timezone)
        tzinfo = zoneinfo.ZoneInfo(event_timezone)
    except (ValueError, zoneinfo.ZoneInfoNotFoundError):
        raise JsonableError(_("Invalid timezone"))
    if end < start:
        raise JsonableError(_("The end must not be before the start"))
    if is_all_day and (
        end == start
        or start.astimezone(tzinfo).time() != time(0, 0)
        or end.astimezone(tzinfo).time() != time(0, 0)
    ):
        raise JsonableError(_("An all-day event must span whole days"))
    return event_timezone


def check_calendar_title(title: str) -> str:
    title = title.strip()
    if not title:
        raise JsonableError(_("The title must not be empty"))
    if len(title) > CalendarEvent.MAX_TITLE_LENGTH:
        raise JsonableError(_("The title is too long"))
    return title


def check_show_as(show_as: int) -> None:
    if show_as not in CalendarShowAs.values:
        raise JsonableError(_("Invalid value for show as"))


def check_attendees(
    organizer: UserProfile, required_attendees: list[UserProfile], optional_attendees: list[UserProfile]
) -> dict[int, bool]:
    """Returns whether each attendee other than the organizer is
    required, by user ID."""
    for user in [*required_attendees, *optional_attendees]:
        if user.realm_id != organizer.realm_id or not user.is_active or user.is_bot:
            raise JsonableError(_("Invalid attendee"))
    required_ids = {user.id for user in required_attendees} - {organizer.id}
    optional_ids = {user.id for user in optional_attendees} - {organizer.id}
    if required_ids & optional_ids:
        raise JsonableError(_("An attendee cannot be both required and optional"))
    return {user_id: True for user_id in required_ids} | {
        user_id: False for user_id in optional_ids
    }


def get_default_reminder_minutes(user_ids: set[int]) -> dict[int, int | None]:
    reminder_minutes: dict[int, int | None] = dict.fromkeys(user_ids, DEFAULT_REMINDER_MINUTES)
    for user_id, minutes in CalendarUserSettings.objects.filter(user_id__in=user_ids).values_list(
        "user_id", "default_reminder_minutes"
    ):
        reminder_minutes[user_id] = minutes
    return reminder_minutes


def get_attendee_user_ids(event: CalendarEvent) -> set[int]:
    return set(CalendarAttendee.objects.filter(event=event).values_list("user_id", flat=True))


def send_calendar_change_events(realm: Realm, event: CalendarEvent, user_ids: set[int]) -> None:
    """Tells the users that the event changed in their calendars, and
    those who pinned any of the users that their free/busy times may
    have changed."""
    user_ids_by_count: dict[int, list[int]] = defaultdict(list)
    for user_id, count in get_unanswered_invitation_counts(user_ids).items():
        user_ids_by_count[count].append(user_id)
    for count, count_user_ids in user_ids_by_count.items():
        send_event_on_commit(
            realm,
            CalendarChangeEvent(event_id=event.id, unanswered_invitation_count=count),
            count_user_ids,
        )

    # Each viewer learns only about the users they pinned, which keeps
    # hidden attendees hidden.
    pinned_user_ids_by_viewer_id: dict[int, list[int]] = defaultdict(list)
    for viewer_id, pinned_user_id in CalendarPinnedUser.objects.filter(
        pinned_user_id__in=user_ids
    ).values_list("user_id", "pinned_user_id"):
        pinned_user_ids_by_viewer_id[viewer_id].append(pinned_user_id)
    viewer_ids_by_pinned_user_ids: dict[tuple[int, ...], list[int]] = defaultdict(list)
    for viewer_id, pinned_user_ids in pinned_user_ids_by_viewer_id.items():
        viewer_ids_by_pinned_user_ids[tuple(sorted(pinned_user_ids))].append(viewer_id)
    for user_ids_of_viewers, viewer_ids in viewer_ids_by_pinned_user_ids.items():
        send_event_on_commit(
            realm, CalendarFreeBusyEvent(user_ids=list(user_ids_of_viewers)), viewer_ids
        )


def create_new_attendees(
    event: CalendarEvent,
    is_required_by_user_id: dict[int, bool],
    added_by: UserProfile | None = None,
) -> None:
    reminder_minutes = get_default_reminder_minutes(set(is_required_by_user_id))
    CalendarAttendee.objects.bulk_create(
        CalendarAttendee(
            event=event,
            user_id=user_id,
            is_required=is_required,
            reminder_minutes=reminder_minutes[user_id],
            added_by=added_by,
        )
        for user_id, is_required in is_required_by_user_id.items()
    )
    if event.chat is not None:
        bulk_add_subscriptions(
            event.chat.realm,
            [event.chat],
            UserProfile.objects.filter(id__in=is_required_by_user_id, is_active=True),
            acting_user=added_by,
        )


def get_meeting_chat_name(event: CalendarEvent) -> str:
    """The meeting's title, with a number added if another channel
    already has that name, since channel names are unique."""
    for number in itertools.count(1):
        suffix = "" if number == 1 else f" ({number})"
        name = event.title[: Stream.MAX_NAME_LENGTH - len(suffix)].strip() + suffix
        channels = Stream.objects.filter(realm_id=event.realm_id, name__iexact=name)
        if event.chat_id is not None:
            channels = channels.exclude(id=event.chat_id)
        if not channels.exists():
            return name
    raise AssertionError("unreachable")  # nocoverage


@transaction.atomic(durable=True)
def create_calendar_event(
    organizer: UserProfile,
    *,
    title: str,
    start: datetime,
    end: datetime,
    event_timezone: str,
    is_all_day: bool = False,
    description: str = "",
    location: str = "",
    show_as: int = CalendarShowAs.BUSY,
    is_private: bool = False,
    rrule: str = "",
    response_requested: bool = True,
    allow_forwarding: bool = True,
    hide_attendees: bool = False,
    has_zulip_call: bool = False,
    required_attendees: list[UserProfile],
    optional_attendees: list[UserProfile],
) -> int:
    """Creates the event in the organizer's calendar, and invites the
    attendees, if any. Returns the event's ID."""
    title = check_calendar_title(title)
    event_timezone = check_calendar_event_time(start, end, event_timezone, is_all_day)
    check_show_as(show_as)
    if rrule:
        validate_rrule(rrule)
    is_required_by_user_id = check_attendees(organizer, required_attendees, optional_attendees)

    event = CalendarEvent.objects.create(
        realm_id=organizer.realm_id,
        uid=str(uuid.uuid4()),
        organizer=organizer,
        title=title,
        description=description,
        rendered_description=render_calendar_description(description, organizer),
        location=location,
        start=start,
        end=end,
        timezone=event_timezone,
        is_all_day=is_all_day,
        show_as=show_as,
        is_private=is_private,
        rrule=rrule,
        response_requested=response_requested,
        allow_forwarding=allow_forwarding,
        hide_attendees=hide_attendees,
        has_zulip_call=has_zulip_call,
        meet_code=secrets.token_urlsafe(9),
    )
    CalendarAttendee.objects.create(
        event=event,
        user=organizer,
        response=CalendarResponse.ACCEPTED,
        response_date=event.date_created,
        reminder_minutes=get_default_reminder_minutes({organizer.id})[organizer.id],
    )
    create_new_attendees(event, is_required_by_user_id)
    send_calendar_change_events(organizer.realm, event, get_attendee_user_ids(event))
    return event.id


def access_calendar_event_as_organizer(user_profile: UserProfile, event_id: int) -> CalendarEvent:
    event = access_calendar_event_by_id(user_profile, event_id)
    if event.organizer_id != user_profile.id:
        raise JsonableError(_("Only the organizer can change this event"))
    if event.is_cancelled:
        raise JsonableError(_("This event was cancelled"))
    return event


def check_occurrence(event: CalendarEvent, original_start: datetime) -> None:
    if not event.rrule or not is_occurrence_start(
        event.start, event.timezone, event.rrule, original_start
    ):
        raise JsonableError(_("Invalid occurrence"))


def ask_attendees_to_respond_again(event: CalendarEvent, original_start: datetime | None) -> None:
    attendees = CalendarAttendee.objects.filter(event=event).exclude(user_id=event.organizer_id)
    if original_start is None:
        CalendarAttendeeOccurrenceResponse.objects.filter(attendee__event=event).delete()
        attendees.update(response=CalendarResponse.NONE, response_date=None)
        return
    CalendarAttendeeOccurrenceResponse.objects.filter(
        attendee__event=event, original_start=original_start
    ).delete()
    CalendarAttendeeOccurrenceResponse.objects.bulk_create(
        CalendarAttendeeOccurrenceResponse(
            attendee=attendee, original_start=original_start, response=CalendarResponse.NONE
        )
        for attendee in attendees
    )


def update_calendar_occurrence(
    user_profile: UserProfile,
    event: CalendarEvent,
    original_start: datetime,
    *,
    title: str | None,
    description: str | None,
    location: str | None,
    start: datetime | None,
    end: datetime | None,
) -> None:
    check_occurrence(event, original_start)
    exception, _created = CalendarEventException.objects.get_or_create(
        event=event, original_start=original_start
    )
    if exception.is_cancelled:
        raise JsonableError(_("This occurrence was cancelled"))

    if title is not None:
        exception.title = check_calendar_title(title)
    if description is not None:
        exception.description = description
        exception.rendered_description = render_calendar_description(description, user_profile)
    if location is not None:
        exception.location = location

    time_changed = False
    if start is not None or end is not None:
        old_start = exception.start or original_start
        old_end = exception.end or old_start + (event.end - event.start)
        new_start = start or old_start
        # Moving the start keeps the duration, as in Outlook.
        new_end = end or new_start + (old_end - old_start)
        check_calendar_event_time(new_start, new_end, event.timezone, event.is_all_day)
        time_changed = (new_start, new_end) != (old_start, old_end)
        exception.start = new_start
        exception.end = new_end
    exception.save()

    if time_changed:
        ask_attendees_to_respond_again(event, original_start)
    if time_changed or location is not None:
        event.sequence += 1
    event.last_modified = timezone_now()
    event.save(update_fields=["sequence", "last_modified"])


def update_attendees(
    event: CalendarEvent,
    required_attendees: list[UserProfile] | None,
    optional_attendees: list[UserProfile] | None,
) -> None:
    """A list that is passed replaces the attendees of that kind; an
    attendee passed in one list is no longer in the other."""
    passed = check_attendees(event.organizer, required_attendees or [], optional_attendees or [])
    current = dict(
        CalendarAttendee.objects.filter(event=event)
        .exclude(user_id=event.organizer_id)
        .values_list("user_id", "is_required")
    )
    is_required_by_user_id = {
        user_id: is_required
        for user_id, is_required in current.items()
        if (required_attendees if is_required else optional_attendees) is None
        and user_id not in passed
    } | passed

    CalendarAttendee.objects.filter(event=event).exclude(
        user_id__in=[event.organizer_id, *is_required_by_user_id]
    ).delete()
    for is_required in [True, False]:
        CalendarAttendee.objects.filter(
            event=event,
            user_id__in=[
                user_id
                for user_id, required in is_required_by_user_id.items()
                if required == is_required and current.get(user_id, is_required) != is_required
            ],
        ).update(is_required=is_required)
    create_new_attendees(
        event,
        {
            user_id: is_required
            for user_id, is_required in is_required_by_user_id.items()
            if user_id not in current
        },
    )


@transaction.atomic(durable=True)
def update_calendar_event(
    user_profile: UserProfile,
    event_id: int,
    *,
    original_start: datetime | None = None,
    title: str | None = None,
    description: str | None = None,
    location: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    event_timezone: str | None = None,
    is_all_day: bool | None = None,
    show_as: int | None = None,
    is_private: bool | None = None,
    rrule: str | None = None,
    response_requested: bool | None = None,
    allow_forwarding: bool | None = None,
    hide_attendees: bool | None = None,
    has_zulip_call: bool | None = None,
    required_attendees: list[UserProfile] | None = None,
    optional_attendees: list[UserProfile] | None = None,
) -> None:
    """Changes the series, or with original_start, one occurrence of it.

    Changing when a series takes place drops its changed occurrences,
    as Exchange does, and asks attendees to respond again.
    """
    event = access_calendar_event_as_organizer(user_profile, event_id)
    old_user_ids = get_attendee_user_ids(event)

    if original_start is not None:
        series_fields = [
            event_timezone,
            is_all_day,
            show_as,
            is_private,
            rrule,
            response_requested,
            allow_forwarding,
            hide_attendees,
            has_zulip_call,
            required_attendees,
            optional_attendees,
        ]
        if any(value is not None for value in series_fields):
            raise JsonableError(
                _("Only the time, title, location and description of an occurrence can be changed")
            )
        update_calendar_occurrence(
            user_profile,
            event,
            original_start,
            title=title,
            description=description,
            location=location,
            start=start,
            end=end,
        )
        send_calendar_change_events(user_profile.realm, event, old_user_ids)
        return

    old_time = (event.start, event.end, event.timezone, event.is_all_day, event.rrule)
    if title is not None:
        event.title = check_calendar_title(title)
    if description is not None:
        event.description = description
        event.rendered_description = render_calendar_description(description, user_profile)
    if start is not None:
        # Moving the start keeps the duration, as in Outlook.
        event.end = start + (event.end - event.start)
        event.start = start
    if end is not None:
        event.end = end
    if is_all_day is not None:
        event.is_all_day = is_all_day
    event.timezone = check_calendar_event_time(
        event.start, event.end, event_timezone or event.timezone, event.is_all_day
    )
    if rrule is not None:
        if rrule:
            validate_rrule(rrule)
        event.rrule = rrule
    if show_as is not None:
        check_show_as(show_as)
        event.show_as = show_as
    if is_private is not None:
        event.is_private = is_private
    if response_requested is not None:
        event.response_requested = response_requested
    if allow_forwarding is not None:
        event.allow_forwarding = allow_forwarding
    if hide_attendees is not None:
        event.hide_attendees = hide_attendees
    if has_zulip_call is not None:
        event.has_zulip_call = has_zulip_call

    time_changed = old_time != (
        event.start,
        event.end,
        event.timezone,
        event.is_all_day,
        event.rrule,
    )
    if time_changed:
        CalendarEventException.objects.filter(event=event).delete()
        ask_attendees_to_respond_again(event, None)
    if time_changed or (location is not None and location != event.location):
        event.sequence += 1
    if location is not None:
        event.location = location
    event.last_modified = timezone_now()
    event.save()
    if title is not None and event.chat is not None:
        chat_name = get_meeting_chat_name(event)
        if chat_name != event.chat.name:
            rename_stream_without_notice(
                event.chat,
                chat_name,
                acting_user=user_profile,
                notify_user_ids=can_access_stream_metadata_user_ids(event.chat),
            )

    if required_attendees is not None or optional_attendees is not None:
        update_attendees(event, required_attendees, optional_attendees)
    send_calendar_change_events(
        user_profile.realm, event, old_user_ids | get_attendee_user_ids(event)
    )


@transaction.atomic(durable=True)
def cancel_calendar_event(
    user_profile: UserProfile, event_id: int, original_start: datetime | None = None
) -> None:
    """Cancels the event, or with original_start, one occurrence of
    it; attendees see it as cancelled until they remove it."""
    event = access_calendar_event_as_organizer(user_profile, event_id)
    if original_start is None:
        event.is_cancelled = True
    else:
        check_occurrence(event, original_start)
        CalendarEventException.objects.update_or_create(
            event=event, original_start=original_start, defaults={"is_cancelled": True}
        )
    event.sequence += 1
    event.last_modified = timezone_now()
    event.save(update_fields=["is_cancelled", "sequence", "last_modified"])
    send_calendar_change_events(user_profile.realm, event, get_attendee_user_ids(event))


@transaction.atomic(durable=True)
def respond_to_calendar_event(
    user_profile: UserProfile,
    event_id: int,
    response: int,
    original_start: datetime | None = None,
) -> None:
    """Responds to the event, or with original_start, to one
    occurrence of it. Declining is also how an attendee removes an
    event from their calendar."""
    event = access_calendar_event_by_id(user_profile, event_id)
    if event.organizer_id == user_profile.id:
        raise JsonableError(_("The organizer cannot respond to their own event"))
    if response not in CalendarResponse.values or response == CalendarResponse.NONE:
        raise JsonableError(_("Invalid response"))
    if event.is_cancelled and response != CalendarResponse.DECLINED:
        raise JsonableError(_("This event was cancelled"))

    attendee = CalendarAttendee.objects.get(event=event, user=user_profile)
    if original_start is None:
        attendee.response = response
        attendee.response_date = timezone_now()
        attendee.save(update_fields=["response", "response_date"])
    else:
        check_occurrence(event, original_start)
        CalendarAttendeeOccurrenceResponse.objects.update_or_create(
            attendee=attendee, original_start=original_start, defaults={"response": response}
        )
    send_calendar_change_events(user_profile.realm, event, get_attendee_user_ids(event))


@transaction.atomic(durable=True)
def add_calendar_attendees(
    user_profile: UserProfile, event_id: int, users: list[UserProfile], is_required: bool
) -> None:
    """Invites more people, which attendees may do if the organizer
    allows forwarding the event."""
    event = access_calendar_event_by_id(user_profile, event_id)
    if event.organizer_id != user_profile.id and not event.allow_forwarding:
        raise JsonableError(_("The organizer does not allow forwarding this event"))
    if event.is_cancelled:
        raise JsonableError(_("This event was cancelled"))

    required_attendees, optional_attendees = (users, []) if is_required else ([], users)
    is_required_by_user_id = check_attendees(event.organizer, required_attendees, optional_attendees)
    existing_user_ids = set(
        CalendarAttendee.objects.filter(event=event).values_list("user_id", flat=True)
    )
    new_attendees = {
        user_id: required
        for user_id, required in is_required_by_user_id.items()
        if user_id not in existing_user_ids
    }
    create_new_attendees(event, new_attendees, added_by=user_profile)
    send_calendar_change_events(user_profile.realm, event, get_attendee_user_ids(event))


@transaction.atomic(durable=True)
def update_calendar_attendee_settings(
    user_profile: UserProfile,
    event_id: int,
    *,
    reminder_minutes: int | None | Unset = UNSET,
    category: str | None = None,
    show_as: int | None | Unset = UNSET,
) -> None:
    """Changes the user's own reminder, category and how the event
    shows them, as in their copy of a meeting in Outlook. A show_as of
    None shows them as the event says."""
    event = access_calendar_event_by_id(user_profile, event_id)
    attendee = CalendarAttendee.objects.get(event=event, user=user_profile)
    if not isinstance(reminder_minutes, Unset):
        if reminder_minutes is not None and reminder_minutes < 0:
            raise JsonableError(_("Invalid reminder"))
        attendee.reminder_minutes = reminder_minutes
    if category is not None:
        if category and category not in CALENDAR_CATEGORIES:
            raise JsonableError(_("Invalid category"))
        attendee.category = category
    if not isinstance(show_as, Unset):
        if show_as is not None:
            check_show_as(show_as)
        attendee.show_as = show_as
    attendee.save(update_fields=["reminder_minutes", "category", "show_as"])
    send_calendar_change_events(user_profile.realm, event, {user_profile.id})


@transaction.atomic(durable=True)
def get_or_create_calendar_event_chat(user_profile: UserProfile, event_id: int) -> Stream:
    """The meeting's chat, a private channel without topics with all
    of its attendees, created when someone first opens it. Opening it
    subscribes an attendee who left it."""
    access_calendar_event_by_id(user_profile, event_id)
    # Locked, so that attendees opening the chat at once get the same one.
    event = CalendarEvent.objects.select_for_update().get(id=event_id)
    if event.chat is not None:
        bulk_add_subscriptions(event.chat.realm, [event.chat], [user_profile], acting_user=None)
        return event.chat

    realm = user_profile.realm
    nobody = get_role_based_system_groups_dict(realm)[SystemGroups.NOBODY]
    created = False
    while not created:
        # Another channel may take the name before this one is created.
        chat, created = create_stream_if_needed(
            realm,
            get_meeting_chat_name(event),
            is_meeting_chat=True,
            invite_only=True,
            history_public_to_subscribers=True,
            topics_policy=StreamTopicsPolicyEnum.empty_topic_only.value,
            # Who is in the chat follows who is invited to the meeting.
            can_administer_channel_group=nobody.usergroup_ptr,
            can_remove_subscribers_group=nobody.usergroup_ptr,
            acting_user=event.organizer,
        )
    event.chat = chat
    event.save(update_fields=["chat"])
    bulk_add_subscriptions(
        realm,
        [chat],
        UserProfile.objects.filter(calendarattendee__event=event, is_active=True),
        acting_user=None,
    )
    return chat
