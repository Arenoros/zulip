from django.db import models
from django.db.models import CASCADE, F, Q
from django.utils.timezone import now as timezone_now

from zerver.models.constants import MAX_TOPIC_NAME_LENGTH
from zerver.models.realms import Realm
from zerver.models.streams import Stream
from zerver.models.users import UserProfile

# The calendar is stored in Zulip's database for now and is meant to
# move to Exchange later, so these models follow Exchange's calendar
# items: the same event is identified by its iCalendar UID everywhere,
# and each attendee has their own response, reminder and category,
# like the copy of a meeting in each Outlook mailbox.


class CalendarShowAs(models.IntegerChoices):
    FREE = 1
    TENTATIVE = 2
    BUSY = 3
    OOF = 4
    WORKING_ELSEWHERE = 5


class CalendarResponse(models.IntegerChoices):
    NONE = 1
    ACCEPTED = 2
    TENTATIVE = 3
    DECLINED = 4
    # Teams' "Follow": the attendee gets updates and sees the meeting
    # in their calendar, which shows them as free during it.
    FOLLOWING = 5


class CalendarEvent(models.Model):
    """An event or a meeting, or a series of them if rrule is set."""

    MAX_TITLE_LENGTH = 255
    MAX_LOCATION_LENGTH = 255

    realm = models.ForeignKey(Realm, on_delete=CASCADE)
    # The iCalendar UID, which identifies the event when it moves to
    # Exchange.
    uid = models.TextField()
    organizer = models.ForeignKey(UserProfile, on_delete=CASCADE, related_name="+")

    title = models.CharField(max_length=MAX_TITLE_LENGTH)
    description = models.TextField(default="")
    rendered_description = models.TextField(default="")
    location = models.TextField(default="")

    # In UTC; for a series, those of its first occurrence. An all-day
    # event spans midnight to midnight in its timezone.
    start = models.DateTimeField()
    end = models.DateTimeField()
    # The IANA timezone the event was scheduled in, which the
    # occurrences of a series keep their local time in.
    timezone = models.TextField()
    is_all_day = models.BooleanField(default=False)

    show_as = models.PositiveSmallIntegerField(default=CalendarShowAs.BUSY)
    is_private = models.BooleanField(default=False)
    # An RRULE value without the "RRULE:" prefix, or "" for an event
    # that does not repeat.
    rrule = models.TextField(default="")

    response_requested = models.BooleanField(default=True)
    # Whether attendees may invite more people.
    allow_forwarding = models.BooleanField(default=True)
    hide_attendees = models.BooleanField(default=False)

    has_zulip_call = models.BooleanField(default=False)
    # The code in the meeting's permanent /meet/<code> link.
    meet_code = models.TextField()

    is_cancelled = models.BooleanField(default=False)

    # The meeting's own chat, created when it is first opened.
    chat = models.ForeignKey(Stream, null=True, on_delete=models.SET_NULL, related_name="+")
    # A meeting in a channel is discussed in a topic of that channel
    # instead of a chat of its own.
    channel = models.ForeignKey(Stream, null=True, on_delete=models.SET_NULL, related_name="+")
    topic = models.CharField(max_length=MAX_TOPIC_NAME_LENGTH, default="")

    # The iCalendar SEQUENCE, increased when the organizer changes the
    # time or place, which asks attendees to respond again.
    sequence = models.PositiveIntegerField(default=0)
    date_created = models.DateTimeField(default=timezone_now)
    last_modified = models.DateTimeField(default=timezone_now)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["realm", "uid"], name="zerver_calendarevent_realm_uid"),
            models.UniqueConstraint(
                fields=["realm", "meet_code"], name="zerver_calendarevent_realm_meet_code"
            ),
            models.CheckConstraint(condition=Q(end__gte=F("start")), name="calendarevent_end"),
            models.CheckConstraint(
                condition=Q(chat__isnull=True) | Q(channel__isnull=True),
                name="calendarevent_chat_or_channel",
            ),
        ]


class CalendarRoom(models.Model):
    """A meeting room of the organization, which meetings book by
    inviting it, like a room mailbox in Exchange."""

    MAX_NAME_LENGTH = 60
    MAX_LOCATION_LENGTH = 255
    # As in Django's EmailField.
    MAX_EMAIL_LENGTH = 254

    realm = models.ForeignKey(Realm, on_delete=CASCADE)
    name = models.CharField(max_length=MAX_NAME_LENGTH)
    # How many people fit in the room, if known.
    capacity = models.PositiveIntegerField(null=True)
    # Where the room is, like the building and floor.
    location = models.TextField(default="")
    # The address of the room's mailbox in Exchange, which identifies
    # the room when the calendar moves to Exchange.
    email = models.TextField(default="")
    # Rooms are archived rather than deleted, so that the meetings
    # that booked them keep them.
    is_archived = models.BooleanField(default=False)

    class Meta:
        unique_together = ("realm", "name")


class CalendarEventRoom(models.Model):
    """A meeting room booked by an event; a room is booked only if it
    is free, so it accepts all its bookings."""

    event = models.ForeignKey(CalendarEvent, on_delete=CASCADE)
    room = models.ForeignKey(CalendarRoom, on_delete=CASCADE)

    class Meta:
        unique_together = ("event", "room")


class CalendarEventException(models.Model):
    """An occurrence of a series that was changed or cancelled. Fields
    left null are those of the series."""

    event = models.ForeignKey(CalendarEvent, on_delete=CASCADE)
    # The start the occurrence has according to the series, which is
    # its iCalendar RECURRENCE-ID.
    original_start = models.DateTimeField()
    is_cancelled = models.BooleanField(default=False)

    start = models.DateTimeField(null=True)
    end = models.DateTimeField(null=True)
    title = models.CharField(max_length=CalendarEvent.MAX_TITLE_LENGTH, null=True)
    location = models.TextField(null=True)
    description = models.TextField(null=True)
    rendered_description = models.TextField(null=True)

    class Meta:
        unique_together = ("event", "original_start")


class CalendarAttendee(models.Model):
    """Someone invited to an event; the organizer is one too, having
    accepted it."""

    event = models.ForeignKey(CalendarEvent, on_delete=CASCADE)
    user = models.ForeignKey(UserProfile, on_delete=CASCADE)
    is_required = models.BooleanField(default=True)
    response = models.PositiveSmallIntegerField(default=CalendarResponse.NONE)
    response_date = models.DateTimeField(null=True)
    # The attendee who invited this one, when the organizer allowed
    # attendees to invite more people.
    added_by = models.ForeignKey(
        UserProfile, null=True, on_delete=models.SET_NULL, related_name="+"
    )

    # Minutes before the start, or null for no reminder.
    reminder_minutes = models.PositiveIntegerField(null=True)
    # The name of one of Outlook's default color categories, or "".
    category = models.TextField(default="")
    # Null to show the attendee as the event says.
    show_as = models.PositiveSmallIntegerField(null=True)

    class Meta:
        unique_together = ("event", "user")


class CalendarAttendeeOccurrenceResponse(models.Model):
    """An attendee's response to one occurrence of a series, which
    overrides their response to the series."""

    attendee = models.ForeignKey(CalendarAttendee, on_delete=CASCADE)
    original_start = models.DateTimeField()
    response = models.PositiveSmallIntegerField()

    class Meta:
        unique_together = ("attendee", "original_start")


class CalendarPinnedUser(models.Model):
    """A colleague whose calendar a user shows next to their own."""

    user = models.ForeignKey(UserProfile, on_delete=CASCADE)
    pinned_user = models.ForeignKey(UserProfile, on_delete=CASCADE, related_name="+")
    order = models.PositiveIntegerField()
    # A CSS color like "#4f7cff".
    color = models.TextField()

    class Meta:
        unique_together = ("user", "pinned_user")


DEFAULT_REMINDER_MINUTES = 15


def default_work_days() -> list[int]:
    return [1, 2, 3, 4, 5]


class CalendarUserSettings(models.Model):
    """A user's calendar settings; users without a row have the
    defaults."""

    class View(models.IntegerChoices):
        WEEK = 1
        WORK_WEEK = 2

    user = models.OneToOneField(UserProfile, on_delete=CASCADE)
    # ISO weekdays, Monday being 1.
    work_days = models.JSONField(default=default_work_days)
    # Minutes after midnight in the user's timezone, as in Exchange's
    # working hours.
    work_day_start_minutes = models.PositiveSmallIntegerField(default=9 * 60)
    work_day_end_minutes = models.PositiveSmallIntegerField(default=18 * 60)
    # Minutes before the start, or null for no reminder.
    default_reminder_minutes = models.PositiveIntegerField(
        null=True, default=DEFAULT_REMINDER_MINUTES
    )
    default_view = models.PositiveSmallIntegerField(default=View.WORK_WEEK)
    time_scale_minutes = models.PositiveSmallIntegerField(default=30)
