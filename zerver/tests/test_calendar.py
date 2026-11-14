from datetime import datetime, timedelta, timezone
from typing import Any

from zerver.lib.calendar.changes import (
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
    get_calendar_occurrences,
    get_free_busy,
)
from zerver.lib.calendar.recurrence import get_occurrence_starts, validate_rrule
from zerver.lib.exceptions import JsonableError
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import (
    CalendarAttendee,
    CalendarAttendeeOccurrenceResponse,
    CalendarEvent,
    CalendarEventException,
    CalendarUserSettings,
    UserProfile,
)
from zerver.models.calendar import CalendarResponse, CalendarShowAs


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


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

    def assert_starts(self, rrule: str, expected: list[datetime], start: datetime = MONDAY_10_00) -> None:
        self.assertEqual(
            get_occurrence_starts(start, "Europe/Moscow", rrule, WEEK_START, WEEK_START + timedelta(days=62)),
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
        self.assertEqual(len(event.uid), 36)
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
        for kwargs, error in [
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
        ]:
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
            hamlet, event_id, original_start=tuesday, start=tuesday + timedelta(hours=2), title="Moved"
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
                (timedelta(hours=7), CalendarShowAs.BUSY, None, None),
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
            hamlet, event_id, start=utc(2026, 11, 15, 23), end=utc(2026, 11, 16, 23), is_all_day=True
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

        update_calendar_event(hamlet, event_id, original_start=tuesday, end=tuesday + timedelta(hours=1))
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
            attendees(), {cordelia.full_name: True, othello.full_name: False, prospero.full_name: False}
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
            add_calendar_attendees(hamlet, event_id, [self.example_user("prospero")], is_required=True)

    def test_attendee_settings(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        event_id = self.create_event(hamlet, required_attendees=[cordelia])

        update_calendar_attendee_settings(
            cordelia, event_id, reminder_minutes=None, category="Green category", show_as=CalendarShowAs.FREE
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
