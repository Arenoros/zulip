from collections import defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from typing import Any

from django.db.models import Q
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _

from zerver.lib.calendar.recurrence import get_occurrence_starts, has_occurrence_ending_after
from zerver.lib.exceptions import JsonableError
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.models import (
    CalendarAttendee,
    CalendarAttendeeOccurrenceResponse,
    CalendarEvent,
    CalendarEventException,
    UserProfile,
)
from zerver.models.calendar import CalendarResponse, CalendarShowAs

# Like Exchange's free/busy queries, a request covers at most about
# two months, which also bounds how many occurrences of a series that
# repeats forever are computed.
MAX_CALENDAR_RANGE = timedelta(days=62)


@dataclass
class CalendarAttendeeData:
    user_id: int
    is_required: bool
    response: int
    added_by_id: int | None


@dataclass
class CalendarOccurrence:
    """An occurrence of an event in a user's calendar, or the event
    itself if it does not repeat."""

    event_id: int
    uid: str
    # The start the occurrence has according to the series, or None
    # for an event that does not repeat.
    original_start: datetime | None
    start: datetime
    end: datetime
    timezone: str
    is_all_day: bool
    title: str
    location: str
    description: str
    rendered_description: str
    # As the user is shown.
    show_as: int
    is_private: bool
    is_cancelled: bool
    rrule: str
    organizer_id: int
    # The user's own response, reminder and category.
    response: int
    reminder_minutes: int | None
    category: str
    response_requested: bool
    allow_forwarding: bool
    hide_attendees: bool
    has_zulip_call: bool
    meet_code: str
    chat_id: int | None
    # Empty when the organizer hides the attendees from others.
    attendees: list[CalendarAttendeeData]

    def to_api_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["id"] = result.pop("event_id")
        result["original_start"] = (
            None if self.original_start is None else datetime_to_timestamp(self.original_start)
        )
        result["start"] = datetime_to_timestamp(self.start)
        result["end"] = datetime_to_timestamp(self.end)
        for attendee in result["attendees"]:
            attendee["added_by"] = attendee.pop("added_by_id")
        return result


@dataclass
class FreeBusyBlock:
    start: datetime
    end: datetime
    show_as: int
    # Only for events the viewer is invited to and may see the
    # details of.
    event_id: int | None
    title: str | None

    def to_api_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["start"] = datetime_to_timestamp(self.start)
        result["end"] = datetime_to_timestamp(self.end)
        return result


def check_calendar_range(start: datetime, end: datetime) -> None:
    if end <= start:
        raise JsonableError(_("The end must be after the start"))
    if end - start > MAX_CALENDAR_RANGE:
        raise JsonableError(_("The range is too long"))


def access_calendar_event_by_id(user_profile: UserProfile, event_id: int) -> CalendarEvent:
    """Events the user is not invited to are reported like those that
    do not exist."""
    try:
        return CalendarEvent.objects.get(
            id=event_id,
            realm_id=user_profile.realm_id,
            calendarattendee__user=user_profile,
        )
    except CalendarEvent.DoesNotExist:
        raise JsonableError(_("Invalid calendar event ID"))


@dataclass
class _Occurrence:
    original_start: datetime | None
    start: datetime
    end: datetime
    exception: CalendarEventException | None


def _get_event_occurrences(
    event: CalendarEvent,
    exceptions: list[CalendarEventException],
    range_start: datetime,
    range_end: datetime,
) -> list[_Occurrence]:
    """The occurrences of the event that overlap the range, with
    changed occurrences where they were moved to."""
    if not event.rrule:
        # The query fetches only those events that overlap the range.
        return [_Occurrence(None, event.start, event.end, None)]

    duration = event.end - event.start
    exceptions_by_original_start = {exception.original_start: exception for exception in exceptions}
    occurrences = [
        _Occurrence(original_start, original_start, original_start + duration, None)
        for original_start in get_occurrence_starts(
            event.start, event.timezone, event.rrule, range_start - duration, range_end
        )
        if original_start not in exceptions_by_original_start
    ]
    for exception in exceptions:
        start = exception.start or exception.original_start
        end = exception.end or start + duration
        if start < range_end and end > range_start:
            occurrences.append(_Occurrence(exception.original_start, start, end, exception))
    occurrences.sort(key=lambda occurrence: occurrence.start)
    return occurrences


def _get_events_in_range(
    attendee_query: Q, range_start: datetime, range_end: datetime
) -> list[CalendarAttendee]:
    # A series is fetched if it starts before the end of the range;
    # whether it has occurrences in the range is computed afterwards.
    return list(
        CalendarAttendee.objects.filter(attendee_query)
        .filter(
            Q(event__rrule="", event__start__lt=range_end, event__end__gt=range_start)
            | (~Q(event__rrule="") & Q(event__start__lt=range_end))
        )
        .select_related("event")
    )


def _get_exceptions_by_event_id(event_ids: set[int]) -> dict[int, list[CalendarEventException]]:
    exceptions_by_event_id: dict[int, list[CalendarEventException]] = defaultdict(list)
    for exception in CalendarEventException.objects.filter(event_id__in=event_ids):
        exceptions_by_event_id[exception.event_id].append(exception)
    return exceptions_by_event_id


def _get_occurrence_responses(
    attendee_ids: set[int],
) -> dict[tuple[int, datetime], int]:
    return {
        (attendee_id, original_start): response
        for attendee_id, original_start, response in CalendarAttendeeOccurrenceResponse.objects.filter(
            attendee_id__in=attendee_ids
        ).values_list("attendee_id", "original_start", "response")
    }


def _override(value: str | None, series_value: str) -> str:
    return series_value if value is None else value


def _get_show_as(attendee: CalendarAttendee, response: int) -> int:
    # Following a meeting keeps the user informed without blocking
    # their time.
    if response == CalendarResponse.FOLLOWING:
        return CalendarShowAs.FREE
    if attendee.show_as is not None:
        return attendee.show_as
    # Like Exchange, a meeting accepted tentatively shows as tentative,
    # unless it does not block time at all.
    if (
        response == CalendarResponse.TENTATIVE
        and attendee.event.show_as != CalendarShowAs.FREE
    ):
        return CalendarShowAs.TENTATIVE
    return attendee.event.show_as


def _make_calendar_occurrence(
    user_profile: UserProfile,
    attendee: CalendarAttendee,
    response: int,
    occurrence: _Occurrence,
    attendees: list[CalendarAttendeeData],
) -> CalendarOccurrence:
    event = attendee.event
    exception = occurrence.exception
    show_attendees = not event.hide_attendees or event.organizer_id == user_profile.id
    return CalendarOccurrence(
        event_id=event.id,
        uid=event.uid,
        original_start=occurrence.original_start,
        start=occurrence.start,
        end=occurrence.end,
        timezone=event.timezone,
        is_all_day=event.is_all_day,
        title=_override(exception.title if exception is not None else None, event.title),
        location=_override(exception.location if exception is not None else None, event.location),
        description=_override(
            exception.description if exception is not None else None, event.description
        ),
        rendered_description=_override(
            exception.rendered_description if exception is not None else None,
            event.rendered_description,
        ),
        show_as=_get_show_as(attendee, response),
        is_private=event.is_private,
        is_cancelled=event.is_cancelled or (exception is not None and exception.is_cancelled),
        rrule=event.rrule,
        organizer_id=event.organizer_id,
        response=response,
        reminder_minutes=attendee.reminder_minutes,
        category=attendee.category,
        response_requested=event.response_requested,
        allow_forwarding=event.allow_forwarding,
        hide_attendees=event.hide_attendees,
        has_zulip_call=event.has_zulip_call,
        meet_code=event.meet_code,
        chat_id=event.chat_id,
        attendees=attendees if show_attendees else [],
    )


def get_calendar_occurrences(
    user_profile: UserProfile, range_start: datetime, range_end: datetime
) -> list[CalendarOccurrence]:
    """The occurrences in the user's calendar that overlap the range.

    Declined occurrences are left out, as Outlook removes declined
    meetings from the calendar, and so are events and occurrences the
    user cancelled as their organizer.
    """
    check_calendar_range(range_start, range_end)

    own_attendees = [
        attendee
        for attendee in _get_events_in_range(Q(user=user_profile), range_start, range_end)
        if not (attendee.event.is_cancelled and attendee.event.organizer_id == user_profile.id)
    ]
    event_ids = {attendee.event_id for attendee in own_attendees}
    exceptions_by_event_id = _get_exceptions_by_event_id(event_ids)

    # The attendees of each event, by the ID of their attendance.
    attendees_by_event_id: dict[int, list[tuple[int, CalendarAttendeeData]]] = defaultdict(list)
    for attendee_id, user_id, event_id, is_required, response, added_by_id in (
        CalendarAttendee.objects.filter(event_id__in=event_ids)
        .order_by("id")
        .values_list("id", "user_id", "event_id", "is_required", "response", "added_by_id")
    ):
        attendees_by_event_id[event_id].append(
            (attendee_id, CalendarAttendeeData(user_id, is_required, response, added_by_id))
        )
    occurrence_responses = _get_occurrence_responses(
        {
            attendee_id
            for attendees in attendees_by_event_id.values()
            for attendee_id, _ in attendees
        }
    )

    calendar_occurrences = []
    for attendee in own_attendees:
        event = attendee.event
        for occurrence in _get_event_occurrences(
            event, exceptions_by_event_id[event.id], range_start, range_end
        ):
            response = attendee.response
            if occurrence.original_start is not None:
                response = occurrence_responses.get(
                    (attendee.id, occurrence.original_start), response
                )
            exception = occurrence.exception
            if response == CalendarResponse.DECLINED or (
                exception is not None
                and exception.is_cancelled
                and event.organizer_id == user_profile.id
            ):
                continue

            # The attendees' responses to this occurrence.
            attendees = [
                data
                if occurrence.original_start is None
                else replace(
                    data,
                    response=occurrence_responses.get(
                        (attendee_id, occurrence.original_start), data.response
                    ),
                )
                for attendee_id, data in attendees_by_event_id[event.id]
            ]
            calendar_occurrences.append(
                _make_calendar_occurrence(user_profile, attendee, response, occurrence, attendees)
            )
    calendar_occurrences.sort(key=lambda occurrence: occurrence.start)
    return calendar_occurrences


def get_calendar_event(user_profile: UserProfile, event_id: int) -> tuple[CalendarOccurrence, bool]:
    """The event as it is in the user's calendar, with the series'
    first occurrence for a series, and whether some of its occurrences
    were changed or cancelled."""
    event = access_calendar_event_by_id(user_profile, event_id)
    attendee = CalendarAttendee.objects.select_related("event").get(event=event, user=user_profile)
    attendees = [
        CalendarAttendeeData(user_id, is_required, response, added_by_id)
        for user_id, is_required, response, added_by_id in CalendarAttendee.objects.filter(
            event=event
        )
        .order_by("id")
        .values_list("user_id", "is_required", "response", "added_by_id")
    ]
    calendar_event = _make_calendar_occurrence(
        user_profile,
        attendee,
        attendee.response,
        _Occurrence(None, event.start, event.end, None),
        attendees,
    )
    return calendar_event, CalendarEventException.objects.filter(event=event).exists()


def get_free_busy(
    viewer: UserProfile, user_ids: list[int], range_start: datetime, range_end: datetime
) -> dict[int, list[FreeBusyBlock]]:
    """When the users are busy during the range, as anyone in their
    organization may see it.

    The viewer sees the title of an event only if they are invited to
    it, and, for a private event, only if they organize it.
    """
    check_calendar_range(range_start, range_end)

    attendees = _get_events_in_range(
        Q(user_id__in=user_ids, user__realm_id=viewer.realm_id, event__is_cancelled=False),
        range_start,
        range_end,
    )
    event_ids = {attendee.event_id for attendee in attendees}
    exceptions_by_event_id = _get_exceptions_by_event_id(event_ids)
    occurrence_responses = _get_occurrence_responses({attendee.id for attendee in attendees})
    viewer_event_ids = set(
        CalendarAttendee.objects.filter(user=viewer, event_id__in=event_ids).values_list(
            "event_id", flat=True
        )
    )

    free_busy: dict[int, list[FreeBusyBlock]] = {user_id: [] for user_id in user_ids}
    for attendee in attendees:
        event = attendee.event
        shows_details = event.id in viewer_event_ids and (
            not event.is_private or event.organizer_id == viewer.id
        )
        for occurrence in _get_event_occurrences(
            event, exceptions_by_event_id[event.id], range_start, range_end
        ):
            if occurrence.exception is not None and occurrence.exception.is_cancelled:
                continue
            response = attendee.response
            if occurrence.original_start is not None:
                response = occurrence_responses.get(
                    (attendee.id, occurrence.original_start), response
                )
            if response == CalendarResponse.DECLINED:
                continue

            title = None
            if shows_details:
                exception = occurrence.exception
                title = _override(exception.title if exception is not None else None, event.title)
            free_busy[attendee.user_id].append(
                FreeBusyBlock(
                    start=occurrence.start,
                    end=occurrence.end,
                    show_as=_get_show_as(attendee, response),
                    event_id=event.id if shows_details else None,
                    title=title,
                )
            )
    for blocks in free_busy.values():
        blocks.sort(key=lambda block: block.start)
    return free_busy


def get_unanswered_invitation_counts(user_ids: set[int]) -> dict[int, int]:
    """How many invitations to events that have not ended each user
    has not responded to, among those whose organizer asked for
    responses."""
    now = timezone_now()
    counts = dict.fromkeys(user_ids, 0)
    for attendee in (
        CalendarAttendee.objects.filter(
            user_id__in=user_ids,
            response=CalendarResponse.NONE,
            event__response_requested=True,
            event__is_cancelled=False,
        )
        .filter(Q(event__rrule="", event__end__gt=now) | ~Q(event__rrule=""))
        .select_related("event")
    ):
        event = attendee.event
        if not event.rrule or has_occurrence_ending_after(
            event.start, event.end, event.timezone, event.rrule, now
        ):
            counts[attendee.user_id] += 1
    return counts
