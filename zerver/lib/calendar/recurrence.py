from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr
from django.utils.translation import gettext as _

from zerver.lib.exceptions import JsonableError

# The repetition rules the calendar offers, which are those Exchange
# can store as a daily, weekly, absolute monthly or absolute yearly
# recurrence pattern: every N days, weeks on some weekdays, months on
# the start's day of the month, or years on the start's date, until a
# date or forever.
SUPPORTED_FREQUENCIES = {"DAILY", "WEEKLY", "MONTHLY", "YEARLY"}
WEEKDAYS = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}
MAX_INTERVAL = 99


def validate_rrule(rrule: str) -> None:
    parts: dict[str, str] = {}
    for part in rrule.split(";"):
        key, sep, value = part.partition("=")
        if not sep or key in parts:
            raise JsonableError(_("Invalid repetition rule"))
        parts[key] = value

    if parts.keys() - {"FREQ", "INTERVAL", "BYDAY", "UNTIL"}:
        raise JsonableError(_("Unsupported repetition rule"))
    if parts.get("FREQ") not in SUPPORTED_FREQUENCIES:
        raise JsonableError(_("Unsupported repetition rule"))
    if "INTERVAL" in parts:
        interval = parts["INTERVAL"]
        if not interval.isdigit() or not 1 <= int(interval) <= MAX_INTERVAL:
            raise JsonableError(_("Invalid repetition rule"))
    if "BYDAY" in parts:
        days = parts["BYDAY"].split(",")
        if parts["FREQ"] != "WEEKLY" or not set(days) <= WEEKDAYS or len(set(days)) != len(days):
            raise JsonableError(_("Unsupported repetition rule"))
    if "UNTIL" in parts:
        try:
            datetime.strptime(parts["UNTIL"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            raise JsonableError(_("Invalid repetition rule"))


def get_occurrence_starts(
    start: datetime, event_timezone: str, rrule: str, range_start: datetime, range_end: datetime
) -> list[datetime]:
    """The starts, in UTC, of the occurrences of a series that start in
    [range_start, range_end).

    The series repeats in its own timezone, so an occurrence keeps its
    local time across daylight saving time changes.
    """
    local_start = start.astimezone(ZoneInfo(event_timezone))
    rule = rrulestr(rrule, dtstart=local_start)
    return [
        occurrence.astimezone(timezone.utc)
        for occurrence in rule.between(range_start, range_end, inc=True)
        if occurrence < range_end
    ]


def is_occurrence_start(
    start: datetime, event_timezone: str, rrule: str, original_start: datetime
) -> bool:
    return bool(
        get_occurrence_starts(
            start, event_timezone, rrule, original_start, original_start + timedelta(seconds=1)
        )
    )


def has_occurrence_ending_after(
    start: datetime, end: datetime, event_timezone: str, rrule: str, moment: datetime
) -> bool:
    rule = rrulestr(rrule, dtstart=start.astimezone(ZoneInfo(event_timezone)))
    return rule.after(moment - (end - start)) is not None
