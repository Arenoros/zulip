from datetime import datetime, timedelta, timezone
from typing import Any
from unittest import mock
from zoneinfo import ZoneInfo

import orjson
import time_machine
from django.conf import settings
from django.utils.timezone import now as timezone_now
from typing_extensions import override

from zerver.actions.realm_settings import do_set_realm_property
from zerver.actions.streams import do_change_stream_group_based_setting
from zerver.actions.user_settings import do_change_user_setting
from zerver.actions.video_calls import do_end_livekit_call
from zerver.lib.calendar.changes import (
    access_calendar_event_channel,
    add_calendar_attendees,
    cancel_calendar_event,
    create_calendar_event,
    respond_to_calendar_event,
    update_calendar_attendee_settings,
    update_calendar_event,
)
from zerver.lib.calendar.occurrences import (
    CalendarOccurrence,
    access_calendar_event_by_id,
    get_calendar_event,
    get_calendar_occurrences,
    get_free_busy,
    get_unanswered_invitation_counts,
)
from zerver.lib.calendar.recurrence import get_occurrence_starts, validate_rrule
from zerver.lib.calendar.rooms import create_calendar_room, update_calendar_room
from zerver.lib.calendar.user_settings import update_calendar_user_settings
from zerver.lib.exceptions import JsonableError
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.test_helpers import get_subscription
from zerver.lib.timestamp import datetime_to_global_time
from zerver.lib.topic import messages_for_topic
from zerver.models import (
    CalendarAttendee,
    CalendarAttendeeOccurrenceResponse,
    CalendarEvent,
    CalendarEventException,
    CalendarEventRoom,
    CalendarPinnedUser,
    CalendarRoom,
    CalendarUserSettings,
    LiveKitCall,
    Message,
    Realm,
    Stream,
    UserProfile,
)
from zerver.models.calendar import CalendarResponse, CalendarShowAs
from zerver.models.groups import NamedUserGroup, SystemGroups
from zerver.models.realms import get_realm
from zerver.models.streams import StreamTopicsPolicyEnum
from zerver.models.users import get_system_bot
from zerver.views.calendar import MAX_FREE_BUSY_USERS


def utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


# Monday, November 16, 2026, 10:00 in Moscow.
MONDAY_10_00 = utc(2026, 11, 16, 7)
WEEK_START = utc(2026, 11, 16)
WEEK_END = utc(2026, 11, 23)


class RecurrenceTest(ZulipTestCase):
    def test_validate_rrule(self) -> None:
        for rrule in [
            "FREQ=DAILY",
            "FREQ=DAILY;INTERVAL=3",
            "FREQ=WEEKLY;BYDAY=MO,WE,FR",
            "FREQ=MONTHLY;INTERVAL=2",
            "FREQ=YEARLY;UNTIL=20301231T210000Z",
        ]:
            validate_rrule(rrule)

        for rrule, error in [
            ("FREQ=HOURLY", "Unsupported repetition rule"),
            ("FREQ=WEEKLY;COUNT=5", "Unsupported repetition rule"),
            ("FREQ=MONTHLY;BYMONTHDAY=15", "Unsupported repetition rule"),
            ("FREQ=MONTHLY;BYDAY=1MO", "Unsupported repetition rule"),
            ("FREQ=DAILY;BYDAY=MO", "Unsupported repetition rule"),
            ("FREQ=WEEKLY;BYDAY=MO,MO", "Unsupported repetition rule"),
            ("INTERVAL=2", "Unsupported repetition rule"),
            ("FREQ=DAILY;INTERVAL=0", "Invalid repetition rule"),
            ("FREQ=DAILY;INTERVAL=100", "Invalid repetition rule"),
            ("FREQ=DAILY;FREQ=WEEKLY", "Invalid repetition rule"),
            ("FREQ", "Invalid repetition rule"),
            ("FREQ=DAILY;UNTIL=20301231", "Invalid repetition rule"),
        ]:
            with self.assertRaisesRegex(JsonableError, error):
                validate_rrule(rrule)

    def assert_starts(
        self, rrule: str, expected: list[datetime], start: datetime = MONDAY_10_00
    ) -> None:
        self.assertEqual(
            get_occurrence_starts(
                start, "Europe/Moscow", rrule, WEEK_START, WEEK_START + timedelta(days=62)
            ),
            expected,
        )

    def test_get_occurrence_starts(self) -> None:
        self.assert_starts(
            "FREQ=DAILY;INTERVAL=2;UNTIL=20261121T000000Z",
            [MONDAY_10_00 + timedelta(days=days) for days in [0, 2, 4]],
        )
        self.assert_starts(
            "FREQ=WEEKLY;INTERVAL=4;BYDAY=MO,TH",
            [MONDAY_10_00 + timedelta(days=days) for days in [0, 3, 28, 31, 56, 59]],
        )
        self.assert_starts(
            "FREQ=MONTHLY",
            [MONDAY_10_00, utc(2026, 12, 16, 7), utc(2027, 1, 16, 7)],
        )
        self.assert_starts("FREQ=YEARLY", [MONDAY_10_00])
        # A series that started earlier has its occurrences in the range.
        self.assert_starts(
            "FREQ=WEEKLY;INTERVAL=4",
            [utc(2026, 11, 30, 7), utc(2026, 12, 28, 7)],
            start=utc(2026, 11, 2, 7),
        )

    def test_occurrences_keep_local_time_across_daylight_saving_time(self) -> None:
        # Berlin leaves summer time on October 25, 2026.
        starts = get_occurrence_starts(
            utc(2026, 10, 19, 8),
            "Europe/Berlin",
            "FREQ=WEEKLY",
            utc(2026, 10, 19),
            utc(2026, 11, 1),
        )
        self.assertEqual(starts, [utc(2026, 10, 19, 8), utc(2026, 10, 26, 9)])


class CalendarTestCase(ZulipTestCase):
    # Any, since the fields are passed on to create_calendar_event's
    # differently typed keyword arguments.
    def create_event(self, organizer: UserProfile, **kwargs: Any) -> int:
        fields: dict[str, Any] = dict(
            title="Planning",
            start=MONDAY_10_00,
            end=MONDAY_10_00 + timedelta(minutes=30),
            event_timezone="Europe/Moscow",
            required_attendees=[],
            optional_attendees=[],
        )
        fields.update(kwargs)
        return create_calendar_event(organizer, **fields)

    def get_occurrences(self, user: UserProfile) -> list[CalendarOccurrence]:
        return get_calendar_occurrences(user, WEEK_START, WEEK_END)

    def get_attendee(self, event_id: int, user: UserProfile) -> CalendarAttendee:
        return CalendarAttendee.objects.get(event_id=event_id, user=user)


class CreateCalendarEventTest(CalendarTestCase):
    def test_create_meeting(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        CalendarUserSettings.objects.create(user=othello, default_reminder_minutes=None)

        event_id = self.create_event(
            hamlet,
            description="**Agenda**",
            required_attendees=[cordelia, hamlet],
            optional_attendees=[othello],
        )

        event = CalendarEvent.objects.get(id=event_id)
        self.assertEqual(event.organizer, hamlet)
        self.assertEqual(event.rendered_description, "<p><strong>Agenda</strong></p>")
        self.assert_length(event.uid, 36)
        self.assertNotEqual(event.meet_code, "")

        organizer = self.get_attendee(event_id, hamlet)
        self.assertEqual(organizer.response, CalendarResponse.ACCEPTED)
        self.assertTrue(organizer.is_required)
        self.assertEqual(organizer.reminder_minutes, 15)

        attendee = self.get_attendee(event_id, cordelia)
        self.assertEqual(attendee.response, CalendarResponse.NONE)
        self.assertTrue(attendee.is_required)
        optional_attendee = self.get_attendee(event_id, othello)
        self.assertFalse(optional_attendee.is_required)
        self.assertIsNone(optional_attendee.reminder_minutes)

    def test_create_with_invalid_fields(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        invalid_events: list[tuple[dict[str, object], str]] = [
            (dict(title="  "), "The title must not be empty"),
            (dict(title="x" * 256), "The title is too long"),
            (dict(event_timezone="Mars/Olympus"), "Invalid timezone"),
            (dict(end=MONDAY_10_00 - timedelta(minutes=1)), "The end must not be before the start"),
            (dict(is_all_day=True), "An all-day event must span whole days"),
            (dict(show_as=9), "Invalid value for show as"),
            (dict(rrule="FREQ=HOURLY"), "Unsupported repetition rule"),
            (dict(required_attendees=[self.mit_user("sipbtest")]), "Invalid attendee"),
            (dict(required_attendees=[self.example_user("default_bot")]), "Invalid attendee"),
            (
                dict(required_attendees=[cordelia], optional_attendees=[cordelia]),
                "An attendee cannot be both required and optional",
            ),
        ]
        for kwargs, error in invalid_events:
            with self.assertRaisesRegex(JsonableError, error):
                self.create_event(hamlet, **kwargs)
        self.assertFalse(CalendarEvent.objects.exists())

    def test_create_all_day_event(self) -> None:
        hamlet = self.example_user("hamlet")
        # Midnight in Moscow.
        self.create_event(
            hamlet, start=utc(2026, 11, 16, 21), end=utc(2026, 11, 17, 21), is_all_day=True
        )
        (occurrence,) = self.get_occurrences(hamlet)
        self.assertTrue(occurrence.is_all_day)
        self.assertEqual(occurrence.start, utc(2026, 11, 16, 21))


class CalendarOccurrencesTest(CalendarTestCase):
    def test_events_in_range(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        in_range = self.create_event(hamlet, required_attendees=[cordelia])
        self.create_event(
            hamlet, start=WEEK_END, end=WEEK_END + timedelta(hours=1), title="Next week"
        )
        # A multi-day event that started the week before.
        multi_day = self.create_event(
            hamlet, start=WEEK_START - timedelta(days=2), end=WEEK_START + timedelta(hours=1)
        )
        # cordelia is not invited to it.
        self.create_event(self.example_user("othello"))

        self.assertEqual(
            [occurrence.event_id for occurrence in self.get_occurrences(hamlet)],
            [multi_day, in_range],
        )
        (occurrence,) = self.get_occurrences(cordelia)
        self.assertEqual(occurrence.event_id, in_range)
        self.assertEqual(occurrence.organizer_id, hamlet.id)
        self.assertIsNone(occurrence.original_start)
        self.assertEqual(occurrence.response, CalendarResponse.NONE)
        self.assertEqual(
            [attendee.user_id for attendee in occurrence.attendees], [hamlet.id, cordelia.id]
        )

    def test_range_checks(self) -> None:
        hamlet = self.example_user("hamlet")
        with self.assertRaisesRegex(JsonableError, "The end must be after the start"):
            get_calendar_occurrences(hamlet, WEEK_END, WEEK_START)
        with self.assertRaisesRegex(JsonableError, "The range is too long"):
            get_free_busy(hamlet, [hamlet.id], WEEK_START, WEEK_START + timedelta(days=63))

    def test_series_with_changed_occurrences(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])
        tuesday = MONDAY_10_00 + timedelta(days=1)
        wednesday = MONDAY_10_00 + timedelta(days=2)
        thursday = MONDAY_10_00 + timedelta(days=3)
        update_calendar_event(
            hamlet,
            event_id,
            original_start=tuesday,
            start=tuesday + timedelta(hours=2),
            title="Moved",
        )
        cancel_calendar_event(hamlet, event_id, original_start=wednesday)
        # Moved out of the week.
        update_calendar_event(
            hamlet,
            event_id,
            original_start=thursday,
            start=WEEK_END + timedelta(hours=10),
            end=WEEK_END + timedelta(hours=11),
        )
        respond_to_calendar_event(
            cordelia, event_id, CalendarResponse.DECLINED, original_start=MONDAY_10_00
        )

        later_days = [MONDAY_10_00 + timedelta(days=days) for days in [4, 5, 6]]
        occurrences = self.get_occurrences(hamlet)
        self.assertEqual(
            [(occurrence.original_start, occurrence.start) for occurrence in occurrences],
            [
                (MONDAY_10_00, MONDAY_10_00),
                (tuesday, tuesday + timedelta(hours=2)),
                *[(day, day) for day in later_days],
            ],
        )
        self.assertEqual(occurrences[0].title, "Planning")
        self.assertEqual(occurrences[1].title, "Moved")
        self.assertEqual(occurrences[1].end, tuesday + timedelta(hours=2, minutes=30))

        # cordelia declined Monday's occurrence, and sees Wednesday's
        # as cancelled.
        occurrences = self.get_occurrences(cordelia)
        self.assertEqual(
            [(occurrence.original_start, occurrence.is_cancelled) for occurrence in occurrences],
            [(tuesday, False), (wednesday, True), *[(day, False) for day in later_days]],
        )

    def test_declined_and_cancelled_events(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        event_id = self.create_event(hamlet, required_attendees=[cordelia, othello])
        respond_to_calendar_event(othello, event_id, CalendarResponse.DECLINED)
        cancel_calendar_event(hamlet, event_id)

        self.assertEqual(self.get_occurrences(hamlet), [])
        self.assertEqual(self.get_occurrences(othello), [])
        (occurrence,) = self.get_occurrences(cordelia)
        self.assertTrue(occurrence.is_cancelled)

        # Removing it from the calendar is declining it.
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.DECLINED)
        self.assertEqual(self.get_occurrences(cordelia), [])

    def test_hidden_attendees(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        self.create_event(hamlet, hide_attendees=True, required_attendees=[cordelia])
        self.assert_length(self.get_occurrences(hamlet)[0].attendees, 2)
        self.assertEqual(self.get_occurrences(cordelia)[0].attendees, [])

    def test_attendees_respond_to_occurrences(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        event_id = self.create_event(
            hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia, othello]
        )
        respond_to_calendar_event(othello, event_id, CalendarResponse.ACCEPTED)
        tuesday = MONDAY_10_00 + timedelta(days=1)
        respond_to_calendar_event(
            cordelia, event_id, CalendarResponse.TENTATIVE, original_start=tuesday
        )

        monday, tuesday_occurrence = self.get_occurrences(othello)[:2]
        responses = {
            attendee.user_id: attendee.response for attendee in tuesday_occurrence.attendees
        }
        self.assertEqual(
            (responses[cordelia.id], responses[othello.id]),
            (CalendarResponse.TENTATIVE, CalendarResponse.ACCEPTED),
        )
        responses = {attendee.user_id: attendee.response for attendee in monday.attendees}
        self.assertEqual(responses[cordelia.id], CalendarResponse.NONE)

    def test_access_calendar_event(self) -> None:
        hamlet = self.example_user("hamlet")
        event_id = self.create_event(hamlet)
        self.assertEqual(access_calendar_event_by_id(hamlet, event_id).id, event_id)
        with self.assertRaisesRegex(JsonableError, "Invalid calendar event ID"):
            access_calendar_event_by_id(self.example_user("cordelia"), event_id)


class FreeBusyTest(CalendarTestCase):
    def test_free_busy(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")

        shared = self.create_event(hamlet, title="Shared", required_attendees=[cordelia])
        self.create_event(
            hamlet,
            title="Not shared",
            start=MONDAY_10_00 + timedelta(hours=1),
            end=MONDAY_10_00 + timedelta(hours=2),
            show_as=CalendarShowAs.TENTATIVE,
        )
        private = self.create_event(
            hamlet,
            title="Private",
            start=MONDAY_10_00 + timedelta(hours=3),
            end=MONDAY_10_00 + timedelta(hours=4),
            is_private=True,
            required_attendees=[cordelia],
        )
        followed = self.create_event(
            othello,
            title="Followed",
            start=MONDAY_10_00 + timedelta(hours=5),
            end=MONDAY_10_00 + timedelta(hours=6),
            required_attendees=[hamlet],
        )
        respond_to_calendar_event(hamlet, followed, CalendarResponse.FOLLOWING)
        maybe = self.create_event(
            othello,
            title="Maybe",
            start=MONDAY_10_00 + timedelta(hours=6),
            end=MONDAY_10_00 + timedelta(hours=7),
            required_attendees=[hamlet],
        )
        respond_to_calendar_event(hamlet, maybe, CalendarResponse.TENTATIVE)
        maybe_free = self.create_event(
            othello,
            title="Maybe, but free",
            start=MONDAY_10_00 + timedelta(hours=8),
            end=MONDAY_10_00 + timedelta(hours=9),
            show_as=CalendarShowAs.FREE,
            required_attendees=[hamlet],
        )
        respond_to_calendar_event(hamlet, maybe_free, CalendarResponse.TENTATIVE)
        declined = self.create_event(othello, title="Declined", required_attendees=[hamlet])
        respond_to_calendar_event(hamlet, declined, CalendarResponse.DECLINED)
        cancelled = self.create_event(hamlet, title="Cancelled")
        cancel_calendar_event(hamlet, cancelled)
        series = self.create_event(
            hamlet,
            title="Daily",
            rrule="FREQ=DAILY;UNTIL=20261118T000000Z",
            start=MONDAY_10_00 + timedelta(hours=7),
            end=MONDAY_10_00 + timedelta(hours=8),
        )
        cancel_calendar_event(
            hamlet, series, original_start=MONDAY_10_00 + timedelta(days=1, hours=7)
        )
        update_calendar_attendee_settings(hamlet, shared, show_as=CalendarShowAs.OOF)

        def blocks(viewer: UserProfile) -> list[tuple[object, ...]]:
            return [
                (block.start - MONDAY_10_00, block.show_as, block.event_id, block.title)
                for block in get_free_busy(viewer, [hamlet.id], WEEK_START, WEEK_END)[hamlet.id]
            ]

        self.assertEqual(
            blocks(cordelia),
            [
                (timedelta(0), CalendarShowAs.OOF, shared, "Shared"),
                (timedelta(hours=1), CalendarShowAs.TENTATIVE, None, None),
                (timedelta(hours=3), CalendarShowAs.BUSY, None, None),
                (timedelta(hours=5), CalendarShowAs.FREE, None, None),
                (timedelta(hours=6), CalendarShowAs.TENTATIVE, None, None),
                (timedelta(hours=7), CalendarShowAs.BUSY, None, None),
                (timedelta(hours=8), CalendarShowAs.FREE, None, None),
            ],
        )
        # The organizer of a private event sees its title.
        self.assertIn((timedelta(hours=3), CalendarShowAs.BUSY, private, "Private"), blocks(hamlet))
        # Administrators see only free/busy too.
        self.assertEqual(blocks(iago)[0], (timedelta(0), CalendarShowAs.OOF, None, None))

        # Users of another organization have no free/busy.
        self.assertEqual(
            get_free_busy(self.mit_user("sipbtest"), [hamlet.id], WEEK_START, WEEK_END),
            {hamlet.id: []},
        )


class UpdateCalendarEventTest(CalendarTestCase):
    def test_change_title_keeps_responses(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.ACCEPTED)
        update_calendar_event(
            hamlet, event_id, original_start=MONDAY_10_00 + timedelta(days=1), title="Moved"
        )

        update_calendar_event(hamlet, event_id, title="Weekly planning", description="*Notes*")

        event = CalendarEvent.objects.get(id=event_id)
        self.assertEqual(event.title, "Weekly planning")
        self.assertEqual(event.rendered_description, "<p><em>Notes</em></p>")
        self.assertEqual(event.sequence, 0)
        self.assertEqual(self.get_attendee(event_id, cordelia).response, CalendarResponse.ACCEPTED)
        self.assertTrue(CalendarEventException.objects.filter(event_id=event_id).exists())

    def test_change_time_asks_to_respond_again(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.ACCEPTED)
        respond_to_calendar_event(
            cordelia, event_id, CalendarResponse.TENTATIVE, original_start=MONDAY_10_00
        )
        update_calendar_event(
            hamlet, event_id, original_start=MONDAY_10_00 + timedelta(days=1), title="Moved"
        )

        update_calendar_event(hamlet, event_id, rrule="FREQ=WEEKLY;BYDAY=MO,TH")

        event = CalendarEvent.objects.get(id=event_id)
        self.assertEqual(event.sequence, 1)
        self.assertEqual(self.get_attendee(event_id, cordelia).response, CalendarResponse.NONE)
        self.assertEqual(self.get_attendee(event_id, hamlet).response, CalendarResponse.ACCEPTED)
        self.assertFalse(CalendarEventException.objects.filter(event_id=event_id).exists())
        self.assertFalse(CalendarAttendeeOccurrenceResponse.objects.exists())

        update_calendar_event(hamlet, event_id, location="Room 1")
        self.assertEqual(CalendarEvent.objects.get(id=event_id).sequence, 2)
        update_calendar_event(hamlet, event_id, location="Room 1")
        self.assertEqual(CalendarEvent.objects.get(id=event_id).sequence, 2)

        # Moving the start keeps the duration.
        update_calendar_event(hamlet, event_id, start=MONDAY_10_00 + timedelta(hours=1))
        event.refresh_from_db()
        self.assertEqual(event.end, MONDAY_10_00 + timedelta(hours=1, minutes=30))

    def test_change_settings(self) -> None:
        hamlet = self.example_user("hamlet")
        event_id = self.create_event(hamlet)
        update_calendar_event(
            hamlet,
            event_id,
            event_timezone="Europe/Berlin",
            show_as=CalendarShowAs.WORKING_ELSEWHERE,
            is_private=True,
            response_requested=False,
            allow_forwarding=False,
            hide_attendees=True,
            has_zulip_call=True,
        )
        event = CalendarEvent.objects.get(id=event_id)
        self.assertEqual(event.timezone, "Europe/Berlin")
        self.assertEqual(event.show_as, CalendarShowAs.WORKING_ELSEWHERE)
        self.assertTrue(event.is_private)
        self.assertFalse(event.response_requested)
        self.assertFalse(event.allow_forwarding)
        self.assertTrue(event.hide_attendees)
        self.assertTrue(event.has_zulip_call)
        self.assertEqual(event.sequence, 1)

        # Midnight in Berlin.
        update_calendar_event(
            hamlet,
            event_id,
            start=utc(2026, 11, 15, 23),
            end=utc(2026, 11, 16, 23),
            is_all_day=True,
        )
        event.refresh_from_db()
        self.assertTrue(event.is_all_day)
        self.assertEqual((event.start, event.end), (utc(2026, 11, 15, 23), utc(2026, 11, 16, 23)))
        self.assertEqual(event.sequence, 2)

    def test_change_occurrence(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])
        tuesday = MONDAY_10_00 + timedelta(days=1)
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.ACCEPTED)

        update_calendar_event(
            hamlet, event_id, original_start=tuesday, location="Room 2", description="**Moved**"
        )
        exception = CalendarEventException.objects.get(event_id=event_id)
        self.assertEqual(exception.location, "Room 2")
        self.assertEqual(exception.rendered_description, "<p><strong>Moved</strong></p>")
        self.assertIsNone(exception.start)
        self.assertEqual(CalendarEvent.objects.get(id=event_id).sequence, 1)
        self.assertFalse(CalendarAttendeeOccurrenceResponse.objects.exists())

        update_calendar_event(
            hamlet, event_id, original_start=tuesday, end=tuesday + timedelta(hours=1)
        )
        exception.refresh_from_db()
        self.assertEqual((exception.start, exception.end), (tuesday, tuesday + timedelta(hours=1)))
        occurrence_response = CalendarAttendeeOccurrenceResponse.objects.get()
        self.assertEqual(occurrence_response.attendee.user, cordelia)
        self.assertEqual(occurrence_response.response, CalendarResponse.NONE)

        cases: list[tuple[dict[str, Any], str]] = [
            (dict(original_start=tuesday + timedelta(hours=1)), "Invalid occurrence"),
            (dict(original_start=tuesday, is_private=True), "Only the time, title, location"),
            (dict(original_start=tuesday, end=tuesday - timedelta(hours=1)), "The end must not be"),
        ]
        for kwargs, error in cases:
            with self.assertRaisesRegex(JsonableError, error):
                update_calendar_event(hamlet, event_id, **kwargs)

        cancel_calendar_event(hamlet, event_id, original_start=tuesday)
        with self.assertRaisesRegex(JsonableError, "This occurrence was cancelled"):
            update_calendar_event(hamlet, event_id, original_start=tuesday, title="Back")

        single_event_id = self.create_event(hamlet)
        with self.assertRaisesRegex(JsonableError, "Invalid occurrence"):
            update_calendar_event(hamlet, single_event_id, original_start=MONDAY_10_00, title="x")

    def test_change_attendees(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        prospero = self.example_user("prospero")
        event_id = self.create_event(
            hamlet, required_attendees=[cordelia, othello], optional_attendees=[iago]
        )
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.ACCEPTED)

        def attendees() -> dict[str, bool]:
            return {
                attendee.user.full_name: attendee.is_required
                for attendee in CalendarAttendee.objects.filter(event_id=event_id).exclude(
                    user=hamlet
                )
            }

        # othello moves to the optional attendees; iago is removed.
        update_calendar_event(hamlet, event_id, optional_attendees=[othello, prospero])
        self.assertEqual(
            attendees(),
            {cordelia.full_name: True, othello.full_name: False, prospero.full_name: False},
        )
        self.assertEqual(self.get_attendee(event_id, cordelia).response, CalendarResponse.ACCEPTED)

        update_calendar_event(hamlet, event_id, required_attendees=[othello, hamlet])
        self.assertEqual(attendees(), {othello.full_name: True, prospero.full_name: False})
        self.assertEqual(self.get_attendee(event_id, hamlet).response, CalendarResponse.ACCEPTED)

    def test_only_organizer_changes_event(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])
        with self.assertRaisesRegex(JsonableError, "Only the organizer can change this event"):
            update_calendar_event(cordelia, event_id, title="Mine")
        with self.assertRaisesRegex(JsonableError, "Only the organizer can change this event"):
            cancel_calendar_event(cordelia, event_id)
        with self.assertRaisesRegex(JsonableError, "Invalid calendar event ID"):
            update_calendar_event(self.example_user("othello"), event_id, title="Mine")

        cancel_calendar_event(hamlet, event_id)
        self.assertEqual(CalendarEvent.objects.get(id=event_id).sequence, 1)
        with self.assertRaisesRegex(JsonableError, "This event was cancelled"):
            update_calendar_event(hamlet, event_id, title="Back")


class RespondToCalendarEventTest(CalendarTestCase):
    def test_respond(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])

        respond_to_calendar_event(cordelia, event_id, CalendarResponse.TENTATIVE)
        attendee = self.get_attendee(event_id, cordelia)
        self.assertEqual(attendee.response, CalendarResponse.TENTATIVE)
        self.assertIsNotNone(attendee.response_date)
        # The meeting shows as tentative in the attendee's calendar.
        self.assertEqual(self.get_occurrences(cordelia)[0].show_as, CalendarShowAs.TENTATIVE)

        respond_to_calendar_event(
            cordelia, event_id, CalendarResponse.ACCEPTED, original_start=MONDAY_10_00
        )
        respond_to_calendar_event(
            cordelia, event_id, CalendarResponse.DECLINED, original_start=MONDAY_10_00
        )
        occurrence_response = CalendarAttendeeOccurrenceResponse.objects.get()
        self.assertEqual(occurrence_response.response, CalendarResponse.DECLINED)

        for user, response, error in [
            (hamlet, CalendarResponse.ACCEPTED, "The organizer cannot respond"),
            (cordelia, CalendarResponse.NONE, "Invalid response"),
            (cordelia, 9, "Invalid response"),
        ]:
            with self.assertRaisesRegex(JsonableError, error):
                respond_to_calendar_event(user, event_id, response)
        with self.assertRaisesRegex(JsonableError, "Invalid occurrence"):
            respond_to_calendar_event(
                cordelia,
                event_id,
                CalendarResponse.ACCEPTED,
                original_start=MONDAY_10_00 + timedelta(hours=1),
            )

        cancel_calendar_event(hamlet, event_id)
        with self.assertRaisesRegex(JsonableError, "This event was cancelled"):
            respond_to_calendar_event(cordelia, event_id, CalendarResponse.ACCEPTED)

    def test_forward(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])

        add_calendar_attendees(cordelia, event_id, [othello, cordelia], is_required=False)
        attendee = self.get_attendee(event_id, othello)
        self.assertEqual(attendee.added_by, cordelia)
        self.assertFalse(attendee.is_required)
        self.assertIsNone(self.get_attendee(event_id, cordelia).added_by)

        update_calendar_event(hamlet, event_id, allow_forwarding=False)
        with self.assertRaisesRegex(JsonableError, "The organizer does not allow forwarding"):
            add_calendar_attendees(cordelia, event_id, [iago], is_required=True)
        add_calendar_attendees(hamlet, event_id, [iago], is_required=True)
        self.assertTrue(self.get_attendee(event_id, iago).is_required)

        cancel_calendar_event(hamlet, event_id)
        with self.assertRaisesRegex(JsonableError, "This event was cancelled"):
            add_calendar_attendees(
                hamlet, event_id, [self.example_user("prospero")], is_required=True
            )

    def test_attendee_settings(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])

        update_calendar_attendee_settings(
            cordelia,
            event_id,
            reminder_minutes=None,
            category="Green category",
            show_as=CalendarShowAs.FREE,
        )
        attendee = self.get_attendee(event_id, cordelia)
        self.assertIsNone(attendee.reminder_minutes)
        self.assertEqual(attendee.category, "Green category")
        self.assertEqual(attendee.show_as, CalendarShowAs.FREE)
        (occurrence,) = self.get_occurrences(cordelia)
        self.assertEqual(occurrence.show_as, CalendarShowAs.FREE)
        self.assertEqual(occurrence.category, "Green category")
        self.assertEqual(self.get_occurrences(hamlet)[0].show_as, CalendarShowAs.BUSY)

        update_calendar_attendee_settings(cordelia, event_id, reminder_minutes=5, show_as=None)
        attendee.refresh_from_db()
        self.assertEqual(attendee.reminder_minutes, 5)
        self.assertEqual(attendee.category, "Green category")
        self.assertIsNone(attendee.show_as)

        with self.assertRaisesRegex(JsonableError, "Invalid category"):
            update_calendar_attendee_settings(cordelia, event_id, category="Pink category")
        with self.assertRaisesRegex(JsonableError, "Invalid value for show as"):
            update_calendar_attendee_settings(cordelia, event_id, show_as=9)


def timestamp(value: datetime) -> int:
    return int(value.timestamp())


class MeetingChatTest(CalendarTestCase):
    def get_chat(self, user: UserProfile, event_id: int) -> Stream:
        result = self.api_post(user, f"/api/v1/calendar/events/{event_id}/chat")
        return Stream.objects.get(id=self.assert_json_success(result)["stream_id"])

    def test_create_chat(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        event_id = self.create_event(
            hamlet,
            rrule="FREQ=DAILY",
            required_attendees=[cordelia],
            optional_attendees=[othello],
        )
        self.assertIsNone(CalendarEvent.objects.get(id=event_id).chat)

        chat = self.get_chat(cordelia, event_id)
        self.assertEqual(chat.name, "Planning")
        self.assertTrue(chat.is_meeting_chat)
        self.assertTrue(chat.invite_only)
        self.assertTrue(chat.history_public_to_subscribers)
        self.assertEqual(chat.topics_policy, StreamTopicsPolicyEnum.empty_topic_only.value)
        self.assertEqual(chat.creator, hamlet)
        self.assertEqual(
            set(self.users_subscribed_to_stream(chat.name, hamlet.realm)),
            {hamlet, cordelia, othello},
        )
        # Meeting chats notify like group direct messages.
        subscription = get_subscription(chat.name, cordelia)
        self.assertEqual(
            (
                subscription.desktop_notifications,
                subscription.audible_notifications,
                subscription.push_notifications,
                subscription.email_notifications,
            ),
            (True, True, True, True),
        )

        # Everyone, and every occurrence of the series, has the same chat.
        self.assertEqual(self.get_chat(hamlet, event_id), chat)
        result = self.api_post(
            self.example_user("iago"), f"/api/v1/calendar/events/{event_id}/chat"
        )
        self.assert_json_error(result, "Invalid calendar event ID")

    def test_chat_names_are_unique(self) -> None:
        hamlet = self.example_user("hamlet")
        self.make_stream("Planning")
        first_id = self.create_event(hamlet)
        second_id = self.create_event(hamlet, title="planning")
        self.assertEqual(self.get_chat(hamlet, first_id).name, "Planning (2)")
        self.assertEqual(self.get_chat(hamlet, second_id).name, "planning (3)")

        long_id = self.create_event(hamlet, title="A" * 100)
        self.assertEqual(self.get_chat(hamlet, long_id).name, "A" * Stream.MAX_NAME_LENGTH)

        # Renaming the meeting renames its chat, which keeps a name of
        # its own.
        update_calendar_event(hamlet, first_id, title="Retro")
        self.assertEqual(
            CalendarEvent.objects.values_list("chat__name", flat=True).get(id=first_id), "Retro"
        )
        update_calendar_event(hamlet, second_id, title="Retro")
        self.assertEqual(
            CalendarEvent.objects.values_list("chat__name", flat=True).get(id=second_id),
            "Retro (2)",
        )
        update_calendar_event(hamlet, first_id, title="Retro")
        self.assertEqual(
            CalendarEvent.objects.values_list("chat__name", flat=True).get(id=first_id), "Retro"
        )

    def test_chat_follows_attendees(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])
        chat = self.get_chat(hamlet, event_id)

        # Those invited later join the chat; those removed stay in it.
        update_calendar_event(hamlet, event_id, required_attendees=[othello])
        add_calendar_attendees(othello, event_id, [iago], is_required=False)
        self.assertEqual(
            set(self.users_subscribed_to_stream(chat.name, hamlet.realm)),
            {hamlet, cordelia, othello, iago},
        )

        # An attendee who left the chat returns to it on opening it.
        self.unsubscribe(othello, chat.name)
        self.assertEqual(self.get_chat(othello, event_id), chat)
        self.assertTrue(get_subscription(chat.name, othello).active)


class CalendarNotificationTest(CalendarTestCase):
    def get_notifications(self, user: UserProfile) -> list[str]:
        """The direct messages that Notification Bot sent the user,
        without the link to the calendar."""
        bot = get_system_bot(settings.NOTIFICATION_BOT, user.realm_id)
        return [
            message.content.split(" [Open in calendar](")[0]
            for message in Message.objects.filter(
                realm_id=user.realm_id, sender=bot, usermessage__user_profile=user
            ).order_by("id")
        ]

    def mention(self, user: UserProfile) -> str:
        return f"@_**{user.full_name}|{user.id}**"

    def test_invitation(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        event_id = self.create_event(
            hamlet, required_attendees=[cordelia], optional_attendees=[othello]
        )
        invitation = (
            f"{self.mention(hamlet)} invited you to **Planning** on "
            f"{datetime_to_global_time(MONDAY_10_00)}."
        )
        self.assertEqual(self.get_notifications(cordelia), [invitation])
        self.assertEqual(self.get_notifications(othello), [invitation])
        self.assertEqual(self.get_notifications(hamlet), [])

        # The link opens the occurrence in the calendar.
        bot = get_system_bot(settings.NOTIFICATION_BOT, hamlet.realm_id)
        message = Message.objects.filter(
            realm_id=cordelia.realm_id, sender=bot, usermessage__user_profile=cordelia
        ).last()
        assert message is not None
        self.assertTrue(
            message.content.endswith(
                f" [Open in calendar](http://zulip.testserver/#calendar/event/{event_id}/"
                f"{timestamp(MONDAY_10_00)})"
            )
        )

        # Those invited by forwarding learn who invited them.
        iago = self.example_user("iago")
        add_calendar_attendees(cordelia, event_id, [iago], is_required=False)
        self.assertEqual(
            self.get_notifications(iago),
            [
                (
                    f"{self.mention(cordelia)} invited you to **Planning** on "
                    f"{datetime_to_global_time(MONDAY_10_00)}."
                )
            ],
        )

        # Times may be given in any time zone.
        moscow_start = MONDAY_10_00.astimezone(ZoneInfo("Europe/Moscow"))
        moscow_id = self.create_event(
            hamlet,
            start=moscow_start,
            end=moscow_start + timedelta(hours=1),
            required_attendees=[iago],
        )
        message = Message.objects.filter(
            realm_id=iago.realm_id, sender=bot, usermessage__user_profile=iago
        ).last()
        assert message is not None
        self.assertTrue(
            message.content.endswith(f"#calendar/event/{moscow_id}/{timestamp(MONDAY_10_00)})")
        )

        # Personal events notify nobody.
        self.create_event(hamlet, title="Dentist")
        self.assert_length(self.get_notifications(hamlet), 0)

    def test_changes(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        event_id = self.create_event(
            hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia, othello]
        )

        # Changing who is invited invites and removes people; changing
        # only the title notifies nobody.
        update_calendar_event(
            hamlet, event_id, title="Standup", required_attendees=[cordelia, iago]
        )
        self.assertEqual(
            self.get_notifications(iago)[-1],
            f"{self.mention(hamlet)} invited you to **Standup** on "
            f"{datetime_to_global_time(MONDAY_10_00)}.",
        )
        self.assertEqual(
            self.get_notifications(othello)[-1],
            f"{self.mention(hamlet)} removed you from **Standup**.",
        )
        self.assert_length(self.get_notifications(cordelia), 1)

        # Moving the series or one occurrence tells the attendees.
        new_start = MONDAY_10_00 + timedelta(hours=2)
        update_calendar_event(hamlet, event_id, start=new_start)
        moved = f"{self.mention(hamlet)} moved **Standup** to {datetime_to_global_time(new_start)}."
        self.assertEqual(self.get_notifications(cordelia)[-1], moved)
        self.assertEqual(self.get_notifications(iago)[-1], moved)

        tuesday = new_start + timedelta(days=1)
        update_calendar_event(
            hamlet, event_id, original_start=tuesday, start=tuesday + timedelta(hours=1)
        )
        self.assertEqual(
            self.get_notifications(cordelia)[-1],
            f"{self.mention(hamlet)} moved **Standup** ({datetime_to_global_time(tuesday)}) to "
            f"{datetime_to_global_time(tuesday + timedelta(hours=1))}.",
        )
        update_calendar_event(hamlet, event_id, original_start=tuesday, title="Retro")
        self.assert_length(self.get_notifications(cordelia), 3)

        # Cancelling an occurrence, and the series.
        wednesday = new_start + timedelta(days=2)
        cancel_calendar_event(hamlet, event_id, wednesday)
        self.assertEqual(
            self.get_notifications(iago)[-1],
            f"{self.mention(hamlet)} cancelled **Standup** ({datetime_to_global_time(wednesday)}).",
        )
        cancel_calendar_event(hamlet, event_id)
        self.assertEqual(
            self.get_notifications(cordelia)[-1],
            f"{self.mention(hamlet)} cancelled **Standup**.",
        )
        self.assert_length(self.get_notifications(othello), 2)
        self.assert_length(self.get_notifications(hamlet), 0)

    def test_responses(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])

        respond_to_calendar_event(
            cordelia,
            event_id,
            CalendarResponse.ACCEPTED,
            message="I will join from the train.\nMaybe late.",
        )
        self.assertEqual(
            self.get_notifications(hamlet),
            [
                (
                    f"{self.mention(cordelia)} accepted **Planning**.\n\n"
                    "> I will join from the train.\n> Maybe late.\n\n"
                )
            ],
        )

        tuesday = MONDAY_10_00 + timedelta(days=1)
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.TENTATIVE, tuesday)
        self.assertEqual(
            self.get_notifications(hamlet)[-1],
            f"{self.mention(cordelia)} tentatively accepted **Planning** "
            f"({datetime_to_global_time(tuesday)}).",
        )
        result = self.api_post(
            cordelia,
            f"/api/v1/calendar/events/{event_id}/response",
            {"response": orjson.dumps(CalendarResponse.DECLINED).decode()},
        )
        self.assert_json_success(result)
        self.assertEqual(
            self.get_notifications(hamlet)[-1], f"{self.mention(cordelia)} declined **Planning**."
        )

        # Not asked to, following, without requested responses, or for
        # a cancelled meeting, the organizer is not told.
        result = self.api_post(
            cordelia,
            f"/api/v1/calendar/events/{event_id}/response",
            {
                "response": orjson.dumps(CalendarResponse.ACCEPTED).decode(),
                "notify_organizer": "false",
            },
        )
        self.assert_json_success(result)
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.FOLLOWING)
        cancel_calendar_event(hamlet, event_id, tuesday)
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.DECLINED, tuesday)
        update_calendar_event(hamlet, event_id, response_requested=False)
        respond_to_calendar_event(cordelia, event_id, CalendarResponse.ACCEPTED)
        cancel_calendar_event(hamlet, event_id)
        self.api_delete(cordelia, f"/api/v1/calendar/events/{event_id}")
        self.assert_length(self.get_notifications(hamlet), 3)


class MeetingCallTest(CalendarTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.set_call_provider("livekit")

    def set_call_provider(self, provider: str) -> None:
        do_set_realm_property(
            get_realm("zulip"),
            "video_chat_provider",
            Realm.VIDEO_CHAT_PROVIDERS[provider]["id"],
            acting_user=None,
        )

    def join_call(self, user: UserProfile, event_id: int, **params: str) -> str:
        result = self.api_post(user, f"/api/v1/calendar/events/{event_id}/call", params)
        return self.assert_json_success(result)["url"]

    def call_id(self, call_id: int) -> "mock._patch[mock.MagicMock]":
        return mock.patch("zerver.lib.calendar.calls.secrets.randbelow", return_value=call_id)

    def test_join_call(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, required_attendees=[cordelia], has_zulip_call=True)

        # The first to join starts the call in the meeting's chat.
        with self.call_id(123):
            url = self.join_call(cordelia, event_id)
        chat = CalendarEvent.objects.get(id=event_id).chat
        assert chat is not None
        self.assertEqual(url, f"/calls/livekit/join?call_id=123&channel_id={chat.id}")
        message = self.get_last_message()
        self.assertEqual(message.sender, cordelia)
        self.assertEqual(message.recipient.type_id, chat.id)
        self.assertEqual(message.topic_name(), "")
        self.assertEqual(message.content, f"[Join video call.]({url})")

        # Others join the same call, with video or without.
        self.assertEqual(
            self.join_call(hamlet, event_id, voice_only="true"), f"{url}&voice_only=true"
        )
        self.assertEqual(LiveKitCall.objects.filter(message__recipient=chat.recipient).count(), 1)

        # Once it ends, joining starts another call.
        do_end_livekit_call(LiveKitCall.objects.get(message=message).room)
        with self.call_id(456):
            self.assertEqual(
                self.join_call(hamlet, event_id),
                f"/calls/livekit/join?call_id=456&channel_id={chat.id}",
            )

    def test_who_can_join_call(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        event_id = self.create_event(
            hamlet, required_attendees=[cordelia, othello], has_zulip_call=True
        )
        result = self.api_post(iago, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "Invalid calendar event ID")

        url = self.join_call(hamlet, event_id)
        chat = CalendarEvent.objects.get(id=event_id).chat
        assert chat is not None
        result = self.api_post(iago, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "Invalid calendar event ID")

        # Attendees who left the chat join it again.
        self.unsubscribe(cordelia, chat.name)
        self.assertEqual(self.join_call(cordelia, event_id), url)
        self.assertTrue(get_subscription(chat.name, cordelia).active)

        # People removed from the meeting stay in its chat, and can join
        # its call until they leave the chat.
        update_calendar_event(hamlet, event_id, required_attendees=[cordelia])
        self.assertEqual(self.join_call(othello, event_id), url)
        self.unsubscribe(othello, chat.name)
        result = self.api_post(othello, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "Invalid calendar event ID")

    def test_join_call_errors(self) -> None:
        hamlet = self.example_user("hamlet")
        event_id = self.create_event(hamlet)
        result = self.api_post(hamlet, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "This event has no Zulip call")

        update_calendar_event(hamlet, event_id, has_zulip_call=True)
        self.set_call_provider("jitsi_meet")
        result = self.api_post(hamlet, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "LiveKit is not the call provider of this organization.")

        self.set_call_provider("livekit")
        cancel_calendar_event(hamlet, event_id)
        result = self.api_post(hamlet, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "This event was cancelled")
        # A call that cannot take place does not create the chat.
        self.assertIsNone(CalendarEvent.objects.get(id=event_id).chat)

    def test_meet_link(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, required_attendees=[cordelia], has_zulip_call=True)
        meet_url = f"/meet/{CalendarEvent.objects.get(id=event_id).meet_code}"

        response = self.client_get(meet_url)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("/login/"))

        self.login("iago")
        response = self.client_get(meet_url)
        self.assertEqual(response.status_code, 403)
        self.assert_in_response("No access to this call", response)
        response = self.client_get("/meet/unknown")
        self.assertEqual(response.status_code, 403)

        # Opening the link before the call starts only offers to start
        # it.
        self.login_user(cordelia)
        response = self.client_get(meet_url, {"voice_only": "true"})
        self.assert_in_success_response(
            ["Planning", "Start the call", 'name="voice_only" value="true"'], response
        )
        self.assertIsNone(CalendarEvent.objects.get(id=event_id).chat)
        with self.call_id(123):
            response = self.client_post(meet_url, {"voice_only": "true"})
        chat = CalendarEvent.objects.get(id=event_id).chat
        assert chat is not None
        url = f"/calls/livekit/join?call_id=123&channel_id={chat.id}"
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], f"{url}&voice_only=true")

        # Once the call has started, the link joins it.
        self.login_user(hamlet)
        self.unsubscribe(hamlet, chat.name)
        response = self.client_get(meet_url)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], url)
        self.assertTrue(get_subscription(chat.name, hamlet).active)

        cancel_calendar_event(hamlet, event_id)
        response = self.client_get(meet_url)
        self.assertEqual(response.status_code, 404)
        self.assert_in_response("This event was cancelled", response)

    def test_call_window_title(self) -> None:
        hamlet = self.example_user("hamlet")
        event_id = self.create_event(hamlet, title="Design review", has_zulip_call=True)
        url = self.join_call(hamlet, event_id)
        self.login_user(hamlet)
        self.assert_in_success_response(
            ["<title>Design review | Zulip</title>"], self.client_get(url)
        )


class ChannelMeetingTest(MeetingCallTest):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.hamlet = self.example_user("hamlet")
        self.cordelia = self.example_user("cordelia")
        self.othello = self.example_user("othello")
        self.iago = self.example_user("iago")
        self.channel = self.make_stream("Design", invite_only=True)
        for user in [self.hamlet, self.cordelia]:
            self.subscribe(user, "Design")

    def create_channel_meeting(self, **kwargs: Any) -> int:
        return self.create_event(self.hamlet, channel=self.channel, **kwargs)

    def get_topic_messages(self, topic: str) -> list[str]:
        assert self.channel.recipient_id is not None
        return [
            message.content.split(" [Open in calendar](")[0]
            for message in messages_for_topic(
                self.channel.realm_id, self.channel.recipient_id, topic
            ).order_by("id")
        ]

    def mention(self, user: UserProfile) -> str:
        return f"@_**{user.full_name}|{user.id}**"

    def test_create_channel_meeting(self) -> None:
        event_id = self.create_channel_meeting(required_attendees=[self.othello])
        event = CalendarEvent.objects.get(id=event_id)
        self.assertEqual((event.channel, event.topic), (self.channel, "Planning"))
        self.assertIsNone(event.chat)
        # Notification Bot announces the meeting in its topic, and
        # invites only those invited.
        self.assertEqual(
            self.get_topic_messages("Planning"),
            [
                (
                    f"{self.mention(self.hamlet)} scheduled **Planning** on "
                    f"{datetime_to_global_time(MONDAY_10_00)}."
                )
            ],
        )
        message = self.get_last_message()
        self.assertEqual(message.sender, get_system_bot(settings.NOTIFICATION_BOT, event.realm_id))

        # Another meeting with the same title gets a topic of its own,
        # and renaming a meeting keeps its topic, whose links still work.
        second_id = self.create_channel_meeting()
        self.assertEqual(CalendarEvent.objects.get(id=second_id).topic, "Planning (2)")
        update_calendar_event(self.hamlet, event_id, title="Retro")
        self.assertEqual(CalendarEvent.objects.get(id=event_id).topic, "Planning")

        # A channel without topics discusses its meetings in its
        # general chat.
        self.channel.topics_policy = StreamTopicsPolicyEnum.empty_topic_only.value
        self.channel.save(update_fields=["topics_policy"])
        start = int(MONDAY_10_00.timestamp())
        result = self.api_post(
            self.hamlet,
            "/api/v1/calendar/events",
            {
                "title": "Planning",
                "start": orjson.dumps(start).decode(),
                "end": orjson.dumps(start + 1800).decode(),
                "timezone": "Europe/Moscow",
                "channel_id": orjson.dumps(self.channel.id).decode(),
            },
        )
        event = CalendarEvent.objects.get(id=self.assert_json_success(result)["id"])
        self.assertEqual((event.channel, event.topic), (self.channel, ""))

    def test_create_channel_meeting_errors(self) -> None:
        with self.assertRaisesRegex(JsonableError, "A meeting in a channel cannot be private"):
            self.create_channel_meeting(is_private=True)
        event_id = self.create_channel_meeting()
        with self.assertRaisesRegex(JsonableError, "A meeting in a channel cannot be private"):
            update_calendar_event(self.hamlet, event_id, is_private=True)

        # Not in a channel the organizer cannot access.
        start = int(MONDAY_10_00.timestamp())
        result = self.api_post(
            self.othello,
            "/api/v1/calendar/events",
            {
                "title": "Planning",
                "start": orjson.dumps(start).decode(),
                "end": orjson.dumps(start + 1800).decode(),
                "timezone": "Europe/Moscow",
                "channel_id": orjson.dumps(self.channel.id).decode(),
            },
        )
        self.assert_json_error(result, "Invalid channel ID")

        # Nor in the chat of a meeting.
        chat_meeting_id = self.create_event(self.hamlet)
        result = self.api_post(self.hamlet, f"/api/v1/calendar/events/{chat_meeting_id}/chat")
        chat_id = self.assert_json_success(result)["stream_id"]
        with self.assertRaisesRegex(JsonableError, "Invalid channel ID"):
            access_calendar_event_channel(self.hamlet, chat_id)

        # Nor where the organizer may not post.
        nobody = NamedUserGroup.objects.get(
            name=SystemGroups.NOBODY, realm_for_sharding=self.hamlet.realm, is_system_group=True
        )
        do_change_stream_group_based_setting(
            self.channel, "can_send_message_group", nobody, acting_user=self.iago
        )
        with self.assertRaisesRegex(
            JsonableError, "You do not have permission to post in this channel."
        ):
            access_calendar_event_channel(self.hamlet, self.channel.id)

    def test_subscribers_see_channel_meetings(self) -> None:
        event_id = self.create_channel_meeting(
            required_attendees=[self.othello], rrule="FREQ=DAILY;UNTIL=20261118T235959Z"
        )
        # A subscriber who was not invited sees the meeting, without a
        # response, reminder or category of their own.
        occurrences = self.get_occurrences(self.cordelia)
        self.assert_length(occurrences, 3)
        first = occurrences[0]
        self.assertEqual(
            (first.event_id, first.channel_id, first.topic, first.is_invited),
            (event_id, self.channel.id, "Planning", False),
        )
        self.assertEqual(
            (first.response, first.reminder_minutes, first.category),
            (CalendarResponse.NONE, None, ""),
        )
        self.assertTrue(all(o.is_invited for o in self.get_occurrences(self.othello)))
        calendar_event, _changed = get_calendar_event(self.cordelia, event_id)
        self.assertFalse(calendar_event.is_invited)
        # It is not an invitation, and does not make them busy.
        self.assertEqual(
            get_unanswered_invitation_counts({self.cordelia.id}), {self.cordelia.id: 0}
        )
        self.assertEqual(
            get_free_busy(self.hamlet, [self.cordelia.id], WEEK_START, WEEK_END),
            {self.cordelia.id: []},
        )
        # Only attendees respond to it.
        with self.assertRaisesRegex(JsonableError, "Invalid calendar event ID"):
            respond_to_calendar_event(self.cordelia, event_id, CalendarResponse.ACCEPTED)

        # Others see it only if invited.
        self.assertEqual(self.get_occurrences(self.iago), [])
        with self.assertRaisesRegex(JsonableError, "Invalid calendar event ID"):
            get_calendar_event(self.iago, event_id)

        # Cancelled occurrences and meetings leave the calendars of
        # subscribers who were not invited.
        cancel_calendar_event(self.hamlet, event_id, MONDAY_10_00)
        self.assert_length(self.get_occurrences(self.cordelia), 2)
        cancel_calendar_event(self.hamlet, event_id)
        self.assertEqual(self.get_occurrences(self.cordelia), [])
        with self.assertRaisesRegex(JsonableError, "Invalid calendar event ID"):
            get_calendar_event(self.cordelia, event_id)

        # Leaving the channel hides its meetings.
        self.create_channel_meeting()
        self.assert_length(self.get_occurrences(self.cordelia), 1)
        self.unsubscribe(self.cordelia, "Design")
        self.assertEqual(self.get_occurrences(self.cordelia), [])

    def test_channel_meeting_changes(self) -> None:
        event_id = self.create_channel_meeting(rrule="FREQ=DAILY;UNTIL=20261118T235959Z")
        tuesday = MONDAY_10_00 + timedelta(days=1)
        update_calendar_event(
            self.hamlet, event_id, original_start=tuesday, start=tuesday + timedelta(hours=1)
        )
        update_calendar_event(self.hamlet, event_id, start=MONDAY_10_00 + timedelta(hours=2))
        cancel_calendar_event(self.hamlet, event_id)
        hamlet = self.mention(self.hamlet)
        self.assertEqual(
            self.get_topic_messages("Planning")[1:],
            [
                (
                    f"{hamlet} moved **Planning** ({datetime_to_global_time(tuesday)}) to "
                    f"{datetime_to_global_time(tuesday + timedelta(hours=1))}."
                ),
                (
                    f"{hamlet} moved **Planning** to "
                    f"{datetime_to_global_time(MONDAY_10_00 + timedelta(hours=2))}."
                ),
                f"{hamlet} cancelled **Planning**.",
            ],
        )

    @time_machine.travel(utc(2026, 11, 1), tick=False)
    def test_subscribers_learn_of_changes(self) -> None:
        with self.capture_send_event_calls(expected_num_events=4) as events:
            event_id = self.create_channel_meeting(required_attendees=[self.othello])
        self.assertCountEqual(
            [
                (event["event"], sorted(event["users"]))
                for event in events
                if event["event"]["type"] == "calendar"
            ],
            [
                (
                    {"type": "calendar", "event_id": event_id, "unanswered_invitation_count": 0},
                    sorted([self.hamlet.id, self.cordelia.id]),
                ),
                (
                    {"type": "calendar", "event_id": event_id, "unanswered_invitation_count": 1},
                    [self.othello.id],
                ),
            ],
        )

    def test_channel_meeting_discussion(self) -> None:
        event_id = self.create_channel_meeting(required_attendees=[self.othello])
        # Those who can access the channel discuss the meeting in its
        # topic, invited or not, and no chat is created.
        for user in [self.hamlet, self.cordelia]:
            result = self.api_post(user, f"/api/v1/calendar/events/{event_id}/chat")
            self.assertEqual(
                self.assert_json_success(result),
                {"result": "success", "msg": "", "stream_id": self.channel.id, "topic": "Planning"},
            )
        self.assertIsNone(CalendarEvent.objects.get(id=event_id).chat)
        # Attendees outside of the channel only join the call.
        result = self.api_post(self.othello, f"/api/v1/calendar/events/{event_id}/chat")
        self.assert_json_error(result, "Invalid channel ID")
        result = self.api_post(self.iago, f"/api/v1/calendar/events/{event_id}/chat")
        self.assert_json_error(result, "Invalid calendar event ID")

    def test_channel_meeting_call(self) -> None:
        event_id = self.create_channel_meeting(
            required_attendees=[self.othello], has_zulip_call=True
        )
        # Attendees outside of the channel cannot start the call, since
        # starting it posts to the channel.
        result = self.api_post(self.othello, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(
            result, "The call has not started yet. Someone in the channel will start it."
        )
        meet_url = f"/meet/{CalendarEvent.objects.get(id=event_id).meet_code}"
        self.login_user(self.othello)
        response = self.client_post(meet_url)
        self.assertEqual(response.status_code, 404)
        self.assert_in_response("Someone in the channel will start it.", response)

        # Subscribers start it in the meeting's topic, invited or not.
        with self.call_id(123):
            url = self.join_call(self.cordelia, event_id)
        self.assertEqual(url, f"/calls/livekit/join?call_id=123&channel_id={self.channel.id}")
        message = self.get_last_message()
        self.assertEqual(
            (message.sender, message.recipient_id, message.topic_name()),
            (self.cordelia, self.channel.recipient_id, "Planning"),
        )
        self.assertEqual(self.join_call(self.hamlet, event_id), url)
        self.assertEqual(self.join_call(self.othello, event_id), url)
        result = self.api_post(self.iago, f"/api/v1/calendar/events/{event_id}/call")
        self.assert_json_error(result, "Invalid calendar event ID")

        # The call window shows attendees outside of the channel only
        # the meeting, without the channel's name or chat.
        response = self.client_get(url)
        self.assert_in_success_response(["<title>Planning | Zulip</title>"], response)
        self.assertNotIn("Design", response.content.decode())
        self.login_user(self.cordelia)
        self.assert_in_success_response(
            ["<title>#Design &gt; Planning | Zulip</title>"], self.client_get(url)
        )
        self.login_user(self.iago)
        self.assertEqual(self.client_get(url).status_code, 403)

        # The meeting's permanent link joins the call too.
        self.login_user(self.othello)
        response = self.client_get(meet_url)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], url)


class CalendarAPITest(CalendarTestCase):
    def get_events(self, user: UserProfile) -> list[dict[str, Any]]:
        result = self.api_get(
            user,
            "/api/v1/calendar/events",
            {"start": timestamp(WEEK_START), "end": timestamp(WEEK_END)},
        )
        return self.assert_json_success(result)["events"]

    def test_create_and_get_events(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        result = self.api_post(
            hamlet,
            "/api/v1/calendar/events",
            {
                "title": "Planning",
                "start": timestamp(MONDAY_10_00),
                "end": timestamp(MONDAY_10_00 + timedelta(minutes=30)),
                "timezone": "Europe/Moscow",
                "description": "**Agenda**",
                "location": "Room 1",
                "rrule": "FREQ=DAILY;UNTIL=20261117T235959Z",
                "required_attendees": orjson.dumps([cordelia.id]).decode(),
                "optional_attendees": orjson.dumps([othello.id]).decode(),
            },
        )
        event_id = self.assert_json_success(result)["id"]
        event = CalendarEvent.objects.get(id=event_id)

        first, second = self.get_events(cordelia)
        self.assertEqual(
            first,
            {
                "id": event_id,
                "uid": event.uid,
                "original_start": timestamp(MONDAY_10_00),
                "start": timestamp(MONDAY_10_00),
                "end": timestamp(MONDAY_10_00 + timedelta(minutes=30)),
                "timezone": "Europe/Moscow",
                "is_all_day": False,
                "title": "Planning",
                "location": "Room 1",
                "description": "**Agenda**",
                "rendered_description": "<p><strong>Agenda</strong></p>",
                "show_as": CalendarShowAs.BUSY,
                "is_private": False,
                "is_cancelled": False,
                "rrule": "FREQ=DAILY;UNTIL=20261117T235959Z",
                "organizer_id": hamlet.id,
                "response": CalendarResponse.NONE,
                "reminder_minutes": 15,
                "category": "",
                "response_requested": True,
                "allow_forwarding": True,
                "hide_attendees": False,
                "has_zulip_call": False,
                "meet_code": event.meet_code,
                "chat_id": None,
                "channel_id": None,
                "topic": "",
                "is_invited": True,
                "date_created": timestamp(event.date_created),
                "attendees": [
                    {
                        "user_id": hamlet.id,
                        "is_required": True,
                        "response": CalendarResponse.ACCEPTED,
                        "added_by": None,
                    },
                    {
                        "user_id": cordelia.id,
                        "is_required": True,
                        "response": CalendarResponse.NONE,
                        "added_by": None,
                    },
                    {
                        "user_id": othello.id,
                        "is_required": False,
                        "response": CalendarResponse.NONE,
                        "added_by": None,
                    },
                ],
                "room_ids": [],
            },
        )
        self.assertEqual(second["original_start"], timestamp(MONDAY_10_00 + timedelta(days=1)))

        result = self.api_get(
            cordelia,
            "/api/v1/calendar/events",
            {"start": timestamp(WEEK_START), "end": timestamp(WEEK_START + timedelta(days=63))},
        )
        self.assert_json_error(result, "The range is too long")

        result = self.api_post(
            hamlet,
            "/api/v1/calendar/events",
            {
                "title": "Planning",
                "start": timestamp(MONDAY_10_00),
                "end": timestamp(MONDAY_10_00),
                "timezone": "Europe/Moscow",
                "location": "x" * (CalendarEvent.MAX_LOCATION_LENGTH + 1),
            },
        )
        self.assert_json_error(result, "location is too long (limit: 255 characters)")

    def test_get_event(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        series_id = self.create_event(
            hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia], hide_attendees=True
        )

        result = self.api_get(cordelia, f"/api/v1/calendar/events/{series_id}")
        data = self.assert_json_success(result)
        self.assertFalse(data["has_changed_occurrences"])
        self.assertEqual(data["event"]["attendees"], [])

        # The series, not its first occurrence as it was changed.
        update_calendar_event(hamlet, series_id, original_start=MONDAY_10_00, title="Moved")
        result = self.api_get(hamlet, f"/api/v1/calendar/events/{series_id}")
        data = self.assert_json_success(result)
        self.assertTrue(data["has_changed_occurrences"])
        event = data["event"]
        self.assertEqual(
            (event["original_start"], event["start"], event["title"], event["rrule"]),
            (None, timestamp(MONDAY_10_00), "Planning", "FREQ=DAILY"),
        )
        self.assertEqual(event["response"], CalendarResponse.ACCEPTED)
        self.assertEqual(
            [attendee["user_id"] for attendee in event["attendees"]], [hamlet.id, cordelia.id]
        )

        result = self.api_get(self.example_user("iago"), f"/api/v1/calendar/events/{series_id}")
        self.assert_json_error(result, "Invalid calendar event ID")

    def test_inaccessible_users(self) -> None:
        self.set_up_db_for_testing_user_access()
        polonius = self.example_user("polonius")
        othello = self.example_user("othello")
        params = {
            "title": "Planning",
            "start": timestamp(MONDAY_10_00),
            "end": timestamp(MONDAY_10_00 + timedelta(minutes=30)),
            "timezone": "Europe/Moscow",
        }
        result = self.api_post(
            polonius,
            "/api/v1/calendar/events",
            {**params, "required_attendees": orjson.dumps([othello.id]).decode()},
        )
        self.assert_json_error(result, f"Invalid user ID: {othello.id}")

        result = self.api_post(
            polonius, "/api/v1/calendar/events", {**params, "required_attendees": "[9999]"}
        )
        self.assert_json_error(result, "Invalid user ID: 9999")

    def test_update_and_delete(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        series_id = self.create_event(hamlet, rrule="FREQ=DAILY", required_attendees=[cordelia])

        result = self.api_patch(
            hamlet,
            f"/api/v1/calendar/events/{series_id}",
            {"title": "Weekly planning", "optional_attendees": orjson.dumps([othello.id]).decode()},
        )
        self.assert_json_success(result)
        self.assertEqual(CalendarEvent.objects.get(id=series_id).title, "Weekly planning")
        self.assertFalse(self.get_attendee(series_id, othello).is_required)

        tuesday = MONDAY_10_00 + timedelta(days=1)
        result = self.api_patch(
            hamlet,
            f"/api/v1/calendar/events/{series_id}",
            {"occurrence": timestamp(tuesday), "start": timestamp(tuesday + timedelta(hours=1))},
        )
        self.assert_json_success(result)
        exception = CalendarEventException.objects.get(event_id=series_id)
        self.assertEqual(exception.start, tuesday + timedelta(hours=1))

        result = self.api_patch(cordelia, f"/api/v1/calendar/events/{series_id}", {"title": "Mine"})
        self.assert_json_error(result, "Only the organizer can change this event")

        # An attendee removes an occurrence from their own calendar.
        wednesday = MONDAY_10_00 + timedelta(days=2)
        result = self.api_delete(
            cordelia, f"/api/v1/calendar/events/{series_id}", {"occurrence": timestamp(wednesday)}
        )
        self.assert_json_success(result)
        self.assertEqual(
            CalendarAttendeeOccurrenceResponse.objects.get(
                attendee=self.get_attendee(series_id, cordelia), original_start=wednesday
            ).response,
            CalendarResponse.DECLINED,
        )
        self.assertFalse(
            CalendarEventException.objects.filter(
                event_id=series_id, original_start=wednesday
            ).exists()
        )

        # The organizer cancels the series for everyone.
        result = self.api_delete(hamlet, f"/api/v1/calendar/events/{series_id}")
        self.assert_json_success(result)
        self.assertTrue(CalendarEvent.objects.get(id=series_id).is_cancelled)

        result = self.api_delete(self.example_user("iago"), f"/api/v1/calendar/events/{series_id}")
        self.assert_json_error(result, "Invalid calendar event ID")

    def test_respond_forward_and_personal_settings(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])

        result = self.api_post(
            cordelia,
            f"/api/v1/calendar/events/{event_id}/response",
            {"response": CalendarResponse.TENTATIVE},
        )
        self.assert_json_success(result)
        self.assertEqual(self.get_attendee(event_id, cordelia).response, CalendarResponse.TENTATIVE)

        result = self.api_post(
            cordelia,
            f"/api/v1/calendar/events/{event_id}/attendees",
            {"user_ids": orjson.dumps([othello.id]).decode()},
        )
        self.assert_json_success(result)
        attendee = self.get_attendee(event_id, othello)
        self.assertFalse(attendee.is_required)
        self.assertEqual(attendee.added_by, cordelia)

        url = f"/api/v1/calendar/events/{event_id}/personal_settings"
        result = self.api_patch(
            cordelia, url, {"reminder_minutes": "null", "show_as": CalendarShowAs.TENTATIVE}
        )
        self.assert_json_success(result)
        attendee = self.get_attendee(event_id, cordelia)
        self.assertIsNone(attendee.reminder_minutes)
        self.assertEqual(attendee.show_as, CalendarShowAs.TENTATIVE)

        result = self.api_patch(cordelia, url, {"category": "Blue category", "show_as": "null"})
        self.assert_json_success(result)
        attendee = self.get_attendee(event_id, cordelia)
        self.assertIsNone(attendee.reminder_minutes)
        self.assertEqual(attendee.category, "Blue category")
        self.assertIsNone(attendee.show_as)

        result = self.api_patch(cordelia, url, {"reminder_minutes": -5})
        self.assert_json_error(result, "Invalid reminder")

    def test_free_busy(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])

        def get_free_busy(viewer: UserProfile, user_ids: list[int]) -> Any:
            return self.api_get(
                viewer,
                "/api/v1/calendar/free_busy",
                {
                    "user_ids": orjson.dumps(user_ids).decode(),
                    "start": timestamp(WEEK_START),
                    "end": timestamp(WEEK_END),
                },
            )

        result = get_free_busy(othello, [cordelia.id, othello.id])
        self.assertEqual(
            self.assert_json_success(result)["free_busy"],
            {
                str(cordelia.id): [
                    {
                        "start": timestamp(MONDAY_10_00),
                        "end": timestamp(MONDAY_10_00 + timedelta(minutes=30)),
                        "show_as": CalendarShowAs.BUSY,
                        "event_id": None,
                        "title": None,
                    }
                ],
                str(othello.id): [],
            },
        )

        # When they work: the defaults, or their own settings.
        do_change_user_setting(cordelia, "timezone", "Asia/Tokyo", acting_user=None)
        update_calendar_user_settings(
            othello, work_days=[1, 2, 3, 4], work_day_start_minutes=480, work_day_end_minutes=960
        )
        result = get_free_busy(hamlet, [cordelia.id, othello.id])
        self.assertEqual(
            self.assert_json_success(result)["working_hours"],
            {
                str(cordelia.id): {
                    "timezone": "Asia/Tokyo",
                    "work_days": [1, 2, 3, 4, 5],
                    "work_day_start_minutes": 540,
                    "work_day_end_minutes": 1080,
                },
                str(othello.id): {
                    "timezone": othello.timezone,
                    "work_days": [1, 2, 3, 4],
                    "work_day_start_minutes": 480,
                    "work_day_end_minutes": 960,
                },
            },
        )

        result = get_free_busy(hamlet, [cordelia.id])
        (block,) = self.assert_json_success(result)["free_busy"][str(cordelia.id)]
        self.assertEqual((block["event_id"], block["title"]), (event_id, "Planning"))

        result = get_free_busy(hamlet, list(range(1, MAX_FREE_BUSY_USERS + 2)))
        self.assert_json_error(result, "Too many users")


class CalendarChangeEventsTest(CalendarTestCase):
    def test_unanswered_invitation_counts(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        now = timezone_now().replace(microsecond=0)
        tomorrow = now + timedelta(days=1)
        yesterday = now - timedelta(days=1)

        def create(start: datetime, **kwargs: Any) -> int:
            return self.create_event(
                hamlet,
                start=start,
                end=start + timedelta(hours=1),
                event_timezone="UTC",
                required_attendees=[cordelia],
                **kwargs,
            )

        create(tomorrow)
        create(yesterday, rrule="FREQ=DAILY")
        create(yesterday)
        until = (now - timedelta(hours=2)).strftime("%Y%m%dT%H%M%SZ")
        create(yesterday, rrule=f"FREQ=DAILY;UNTIL={until}")
        create(tomorrow, response_requested=False)
        cancel_calendar_event(hamlet, create(tomorrow))
        respond_to_calendar_event(cordelia, create(tomorrow), CalendarResponse.ACCEPTED)

        self.assertEqual(
            get_unanswered_invitation_counts({hamlet.id, cordelia.id}),
            {hamlet.id: 0, cordelia.id: 2},
        )

    @time_machine.travel(utc(2026, 11, 1), tick=False)
    def test_free_busy_events_name_only_pinned_users(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        iago = self.example_user("iago")
        CalendarPinnedUser.objects.create(user=iago, pinned_user=cordelia, order=1, color="#4f7cff")

        # Besides the calendar events, Notification Bot invites cordelia
        # and othello.
        with self.capture_send_event_calls(expected_num_events=5) as events:
            event_id = self.create_event(
                hamlet, required_attendees=[cordelia, othello], hide_attendees=True
            )
        self.assertCountEqual(
            [
                (event["event"], sorted(event["users"]))
                for event in events
                if event["event"]["type"] != "message"
            ],
            [
                (
                    {"type": "calendar", "event_id": event_id, "unanswered_invitation_count": 0},
                    [hamlet.id],
                ),
                (
                    {"type": "calendar", "event_id": event_id, "unanswered_invitation_count": 1},
                    sorted([cordelia.id, othello.id]),
                ),
                ({"type": "calendar_free_busy", "user_ids": [cordelia.id]}, [iago.id]),
            ],
        )


class CalendarPinnedUsersTest(CalendarTestCase):
    def get_pinned_users(self, user: UserProfile) -> list[dict[str, Any]]:
        result = self.api_get(user, "/api/v1/calendar/pinned_users")
        return self.assert_json_success(result)["pinned_users"]

    def test_pin_and_unpin(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        self.assertEqual(self.get_pinned_users(hamlet), [])

        for user, color in [(othello, "#4f7cff"), (cordelia, "#E5484D")]:
            result = self.api_post(
                hamlet, "/api/v1/calendar/pinned_users", {"user_id": user.id, "color": color}
            )
            self.assert_json_success(result)
        self.assertEqual(
            self.get_pinned_users(hamlet),
            [
                {"user_id": othello.id, "color": "#4f7cff"},
                {"user_id": cordelia.id, "color": "#E5484D"},
            ],
        )
        self.assertEqual(self.get_pinned_users(cordelia), [])

        result = self.api_patch(
            hamlet, f"/api/v1/calendar/pinned_users/{othello.id}", {"color": "#30a46c"}
        )
        self.assert_json_success(result)
        result = self.api_delete(hamlet, f"/api/v1/calendar/pinned_users/{cordelia.id}")
        self.assert_json_success(result)
        self.assertEqual(
            self.get_pinned_users(hamlet), [{"user_id": othello.id, "color": "#30a46c"}]
        )

        result = self.api_post(
            hamlet, "/api/v1/calendar/pinned_users", {"user_id": cordelia.id, "color": "#e5484d"}
        )
        self.assert_json_success(result)
        self.assertEqual(
            [pinned_user["user_id"] for pinned_user in self.get_pinned_users(hamlet)],
            [othello.id, cordelia.id],
        )

    def test_invalid_pins(self) -> None:
        hamlet = self.example_user("hamlet")
        othello = self.example_user("othello")
        url = "/api/v1/calendar/pinned_users"
        self.assert_json_success(
            self.api_post(hamlet, url, {"user_id": othello.id, "color": "#4f7cff"})
        )

        for params, error in [
            ({"user_id": othello.id, "color": "#4f7cff"}, "This calendar is already pinned"),
            ({"user_id": hamlet.id, "color": "#4f7cff"}, "You cannot pin your own calendar"),
            (
                {"user_id": self.example_user("default_bot").id, "color": "#4f7cff"},
                "Invalid user ID",
            ),
            ({"user_id": self.example_user("iago").id, "color": "blue"}, "Invalid color"),
        ]:
            self.assert_json_error_contains(self.api_post(hamlet, url, params), error)

        cordelia = self.example_user("cordelia")
        result = self.api_patch(hamlet, f"{url}/{cordelia.id}", {"color": "#4f7cff"})
        self.assert_json_error(result, "This calendar is not pinned")
        result = self.api_patch(hamlet, f"{url}/{othello.id}", {"color": "#4f7cf"})
        self.assert_json_error(result, "Invalid color")
        result = self.api_delete(hamlet, f"{url}/{cordelia.id}")
        self.assert_json_error(result, "This calendar is not pinned")


class CalendarUserSettingsTest(CalendarTestCase):
    def get_settings(self, user: UserProfile) -> dict[str, Any]:
        result = self.api_get(user, "/api/v1/calendar/settings")
        return self.assert_json_success(result)["settings"]

    def test_get_and_update_settings(self) -> None:
        hamlet = self.example_user("hamlet")
        defaults = {
            "work_days": [1, 2, 3, 4, 5],
            "work_day_start_minutes": 540,
            "work_day_end_minutes": 1080,
            "default_reminder_minutes": 15,
            "default_view": CalendarUserSettings.View.WORK_WEEK,
            "time_scale_minutes": 30,
        }
        self.assertEqual(self.get_settings(hamlet), defaults)
        self.assertFalse(CalendarUserSettings.objects.filter(user=hamlet).exists())

        result = self.api_patch(
            hamlet,
            "/api/v1/calendar/settings",
            {
                "work_days": "[7, 1, 2, 1]",
                "work_day_start_minutes": 480,
                "default_reminder_minutes": "null",
                "default_view": CalendarUserSettings.View.WEEK,
                "time_scale_minutes": 15,
            },
        )
        self.assert_json_success(result)
        changed = {
            "work_days": [1, 2, 7],
            "work_day_start_minutes": 480,
            "work_day_end_minutes": 1080,
            "default_reminder_minutes": None,
            "default_view": CalendarUserSettings.View.WEEK,
            "time_scale_minutes": 15,
        }
        self.assertEqual(self.get_settings(hamlet), changed)
        self.assertEqual(self.get_settings(self.example_user("cordelia")), defaults)

        result = self.api_patch(
            hamlet, "/api/v1/calendar/settings", {"default_reminder_minutes": 30}
        )
        self.assert_json_success(result)
        self.assertEqual(self.get_settings(hamlet), {**changed, "default_reminder_minutes": 30})

        invalid_settings: list[tuple[dict[str, object], str]] = [
            ({"work_days": "[]"}, "Invalid work days"),
            ({"work_days": "[0, 1]"}, "Invalid work days"),
            ({"work_day_start_minutes": 1080}, "Invalid work hours"),
            ({"work_day_end_minutes": 1441}, "Invalid work hours"),
            ({"default_reminder_minutes": -1}, "Invalid reminder"),
            ({"default_view": 3}, "Invalid view"),
            ({"time_scale_minutes": 10}, "Invalid time scale"),
        ]
        for params, error in invalid_settings:
            result = self.api_patch(hamlet, "/api/v1/calendar/settings", params)
            self.assert_json_error(result, error)


class CalendarRoomsTest(CalendarTestCase):
    def get_rooms(self, user: UserProfile) -> list[dict[str, Any]]:
        result = self.api_get(user, "/api/v1/calendar/rooms")
        return self.assert_json_success(result)["rooms"]

    def book(self, organizer: UserProfile, start: datetime, **kwargs: Any) -> int:
        return self.create_event(
            organizer, start=start, end=start + timedelta(minutes=30), **kwargs
        )

    def create_room(self, name: str) -> int:
        return create_calendar_room(
            get_realm("zulip"), name=name, capacity=None, location="", email=""
        )

    def test_manage_rooms(self) -> None:
        iago = self.example_user("iago")
        hamlet = self.example_user("hamlet")
        result = self.api_post(
            iago,
            "/api/v1/calendar/rooms",
            {
                "name": " Blue room ",
                "capacity": 8,
                "location": "Floor 2",
                "email": "blue-room@zulip.com",
            },
        )
        blue_id = self.assert_json_success(result)["id"]
        result = self.api_post(iago, "/api/v1/calendar/rooms", {"name": "Attic"})
        attic_id = self.assert_json_success(result)["id"]
        blue_room = {
            "id": blue_id,
            "name": "Blue room",
            "capacity": 8,
            "location": "Floor 2",
            "email": "blue-room@zulip.com",
            "is_archived": False,
        }
        attic = {
            "id": attic_id,
            "name": "Attic",
            "capacity": None,
            "location": "",
            "email": "",
            "is_archived": False,
        }
        self.assertEqual(self.get_rooms(hamlet), [attic, blue_room])
        result = self.api_get(self.lear_user("king"), "/api/v1/calendar/rooms", subdomain="lear")
        self.assertEqual(self.assert_json_success(result)["rooms"], [])

        result = self.api_post(hamlet, "/api/v1/calendar/rooms", {"name": "Den"})
        self.assert_json_error(result, "Must be an organization administrator")
        result = self.api_patch(hamlet, f"/api/v1/calendar/rooms/{blue_id}", {"name": "Den"})
        self.assert_json_error(result, "Must be an organization administrator")

        invalid_rooms: list[tuple[dict[str, object], str]] = [
            ({"name": " "}, "The name must not be empty"),
            ({"name": "x" * (CalendarRoom.MAX_NAME_LENGTH + 1)}, "The name is too long"),
            ({"name": "blue ROOM"}, "A meeting room with this name already exists"),
            ({"name": "Den", "capacity": 0}, "Invalid capacity"),
            ({"name": "Den", "email": "not an email"}, "Invalid email address"),
        ]
        for params, error in invalid_rooms:
            result = self.api_post(iago, "/api/v1/calendar/rooms", params)
            self.assert_json_error(result, error)
        self.assert_length(self.get_rooms(iago), 2)

        result = self.api_patch(
            iago,
            f"/api/v1/calendar/rooms/{blue_id}",
            {"name": "Blue Room", "capacity": "null", "location": "", "is_archived": "true"},
        )
        self.assert_json_success(result)
        blue_room |= {"name": "Blue Room", "capacity": None, "location": "", "is_archived": True}
        self.assertEqual(self.get_rooms(hamlet), [attic, blue_room])
        result = self.api_patch(
            iago, f"/api/v1/calendar/rooms/{blue_id}", {"email": "", "is_archived": "false"}
        )
        self.assert_json_success(result)
        blue_room |= {"email": "", "is_archived": False}
        self.assertEqual(self.get_rooms(hamlet), [attic, blue_room])

        result = self.api_patch(iago, f"/api/v1/calendar/rooms/{attic_id}", {"name": "blue room"})
        self.assert_json_error(result, "A meeting room with this name already exists")
        lear_room_id = create_calendar_room(
            get_realm("lear"), name="Throne room", capacity=None, location="", email=""
        )
        result = self.api_patch(iago, f"/api/v1/calendar/rooms/{lear_room_id}", {"name": "Den"})
        self.assert_json_error(result, "Invalid meeting room")

    @time_machine.travel(utc(2026, 11, 1), tick=False)
    def test_book_rooms(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        blue_id = self.create_room("Blue room")
        attic_id = self.create_room("Attic")

        event_id = self.create_event(hamlet, room_ids=[blue_id, attic_id])
        self.assertEqual(
            set(
                CalendarEventRoom.objects.filter(event_id=event_id).values_list(
                    "room_id", flat=True
                )
            ),
            {blue_id, attic_id},
        )
        (occurrence,) = self.get_occurrences(hamlet)
        self.assertEqual(occurrence.room_ids, [attic_id, blue_id])
        result = self.api_get(hamlet, f"/api/v1/calendar/events/{event_id}")
        self.assertEqual(self.assert_json_success(result)["event"]["room_ids"], [attic_id, blue_id])

        # A room booked at that time declines, and nothing is saved.
        events = CalendarEvent.objects.count()
        with self.assertRaisesRegex(
            JsonableError, r"^Blue room is booked for another meeting at 2026-11-16 10:15\.$"
        ):
            self.book(cordelia, MONDAY_10_00 + timedelta(minutes=15), room_ids=[blue_id])
        self.assertEqual(CalendarEvent.objects.count(), events)
        # Right after, it is free.
        booked_id = self.book(cordelia, MONDAY_10_00 + timedelta(minutes=30), room_ids=[blue_id])

        # A series declines at its first occurrence that overlaps.
        with self.assertRaisesRegex(
            JsonableError, r"^Attic is booked for another meeting at 2026-11-16 10:00\.$"
        ):
            self.book(
                cordelia,
                MONDAY_10_00 - timedelta(days=3),
                rrule="FREQ=DAILY",
                room_ids=[attic_id],
            )
        # Occurrences after the booking window are not checked, as in
        # Exchange.
        far_start = MONDAY_10_00 + timedelta(days=200)
        self.create_event(
            hamlet, start=far_start, end=far_start + timedelta(hours=1), room_ids=[attic_id]
        )
        series_id = self.book(
            cordelia,
            MONDAY_10_00 + timedelta(days=1),
            rrule="FREQ=DAILY",
            room_ids=[attic_id],
        )

        # Moving an occurrence or the series onto a booked time.
        with self.assertRaisesRegex(JsonableError, "^Attic is booked"):
            update_calendar_event(
                cordelia,
                series_id,
                original_start=MONDAY_10_00 + timedelta(days=1),
                start=MONDAY_10_00,
            )
        with self.assertRaisesRegex(JsonableError, "^Attic is booked"):
            update_calendar_event(cordelia, series_id, start=MONDAY_10_00)
        update_calendar_event(
            cordelia,
            series_id,
            original_start=MONDAY_10_00 + timedelta(days=1),
            start=MONDAY_10_00 + timedelta(days=1, hours=2),
        )
        with self.assertRaisesRegex(
            JsonableError,
            "Only the time, title, location and description of an occurrence can be changed",
        ):
            update_calendar_event(
                cordelia, series_id, original_start=MONDAY_10_00 + timedelta(days=2), room_ids=[]
            )

        # Bookings in the past are not checked.
        past_start = utc(2026, 10, 20, 7)
        self.book(hamlet, past_start, room_ids=[attic_id])
        self.book(cordelia, past_start, room_ids=[attic_id])

        # A cancelled meeting frees its rooms.
        cancel_calendar_event(hamlet, event_id)
        self.create_event(cordelia, room_ids=[attic_id])

        # Changing the rooms asks the attendees to respond again, as a
        # change of the location does.
        sequence = CalendarEvent.objects.get(id=series_id).sequence
        update_calendar_event(cordelia, series_id, room_ids=[attic_id])
        self.assertEqual(CalendarEvent.objects.get(id=series_id).sequence, sequence)
        update_calendar_event(cordelia, series_id, room_ids=[])
        self.assertEqual(CalendarEvent.objects.get(id=series_id).sequence, sequence + 1)
        self.assertFalse(CalendarEventRoom.objects.filter(event_id=series_id).exists())

        # An archived room keeps its bookings, but takes no new ones.
        update_calendar_room(CalendarRoom.objects.get(id=blue_id), is_archived=True)
        update_calendar_event(cordelia, booked_id, title="Review", room_ids=[blue_id])
        for room_ids in [[blue_id, attic_id, attic_id + 1000], [blue_id + 1000]]:
            with self.assertRaisesRegex(JsonableError, "^Invalid meeting room$"):
                self.create_event(hamlet, room_ids=room_ids)
        with self.assertRaisesRegex(JsonableError, "^Invalid meeting room$"):
            self.book(hamlet, MONDAY_10_00 + timedelta(days=3), room_ids=[blue_id])
        lear_room_id = create_calendar_room(
            get_realm("lear"), name="Throne room", capacity=None, location="", email=""
        )
        with self.assertRaisesRegex(JsonableError, "^Invalid meeting room$"):
            self.create_event(hamlet, room_ids=[lear_room_id])

    @time_machine.travel(utc(2026, 11, 1), tick=False)
    def test_room_free_busy(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        blue_id = self.create_room("Blue room")
        attic_id = self.create_room("Attic")
        event_id = self.create_event(hamlet, required_attendees=[cordelia], room_ids=[blue_id])
        private_id = self.create_event(
            hamlet,
            required_attendees=[cordelia],
            start=MONDAY_10_00 + timedelta(hours=1),
            end=MONDAY_10_00 + timedelta(hours=1, minutes=30),
            is_private=True,
            room_ids=[blue_id],
        )
        series_id = self.book(
            hamlet,
            MONDAY_10_00 + timedelta(days=1),
            rrule="FREQ=DAILY",
            room_ids=[attic_id],
        )
        cancel_calendar_event(hamlet, series_id, MONDAY_10_00 + timedelta(days=2))

        def get_room_free_busy(viewer: UserProfile, room_ids: list[int]) -> Any:
            return self.api_get(
                viewer,
                "/api/v1/calendar/free_busy",
                {
                    "user_ids": "[]",
                    "room_ids": orjson.dumps(room_ids).decode(),
                    "start": timestamp(WEEK_START),
                    "end": timestamp(WEEK_END),
                },
            )

        def block(start: datetime, event_id: int | None, title: str | None) -> dict[str, Any]:
            return {
                "start": timestamp(start),
                "end": timestamp(start + timedelta(minutes=30)),
                "show_as": CalendarShowAs.BUSY,
                "event_id": event_id,
                "title": title,
            }

        result = get_room_free_busy(cordelia, [blue_id, attic_id])
        self.assertEqual(
            self.assert_json_success(result)["room_free_busy"],
            {
                str(blue_id): [
                    block(MONDAY_10_00, event_id, "Planning"),
                    block(MONDAY_10_00 + timedelta(hours=1), None, None),
                ],
                str(attic_id): [
                    block(MONDAY_10_00 + timedelta(days=days), None, None)
                    for days in [1, 3, 4, 5, 6]
                ],
            },
        )
        result = get_room_free_busy(hamlet, [blue_id])
        self.assertEqual(
            self.assert_json_success(result)["room_free_busy"][str(blue_id)][1],
            block(MONDAY_10_00 + timedelta(hours=1), private_id, "Planning"),
        )
        result = get_room_free_busy(othello, [blue_id])
        self.assertEqual(
            self.assert_json_success(result)["room_free_busy"][str(blue_id)][0],
            block(MONDAY_10_00, None, None),
        )

        lear_room_id = create_calendar_room(
            get_realm("lear"), name="Throne room", capacity=None, location="", email=""
        )
        result = get_room_free_busy(othello, [lear_room_id])
        self.assert_json_error(result, "Invalid meeting room")
        result = get_room_free_busy(othello, list(range(1, MAX_FREE_BUSY_USERS + 2)))
        self.assert_json_error(result, "Too many users")

    def test_book_rooms_api(self) -> None:
        hamlet = self.example_user("hamlet")
        blue_id = self.create_room("Blue room")
        attic_id = self.create_room("Attic")
        with time_machine.travel(utc(2026, 11, 1), tick=False):
            result = self.api_post(
                hamlet,
                "/api/v1/calendar/events",
                {
                    "title": "Planning",
                    "start": timestamp(MONDAY_10_00),
                    "end": timestamp(MONDAY_10_00 + timedelta(minutes=30)),
                    "timezone": "Europe/Moscow",
                    "room_ids": orjson.dumps([blue_id]).decode(),
                },
            )
            event_id = self.assert_json_success(result)["id"]
            result = self.api_patch(
                hamlet,
                f"/api/v1/calendar/events/{event_id}",
                {"room_ids": orjson.dumps([attic_id]).decode()},
            )
            self.assert_json_success(result)
        self.assertEqual(
            list(
                CalendarEventRoom.objects.filter(event_id=event_id).values_list(
                    "room_id", flat=True
                )
            ),
            [attic_id],
        )
