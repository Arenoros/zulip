import re
from typing import Any

from django.db import transaction
from django.db.models import Max
from django.utils.translation import gettext as _

from zerver.lib.event_types import CalendarSettings, CalendarSettingsEvent
from zerver.lib.exceptions import JsonableError
from zerver.lib.types import UNSET, Unset
from zerver.models import CalendarPinnedUser, CalendarUserSettings, UserProfile
from zerver.tornado.django_api import send_event_on_commit

TIME_SCALE_MINUTES = [15, 30, 60]
MINUTES_PER_DAY = 24 * 60


def check_color(color: str) -> None:
    if re.fullmatch(r"#[0-9a-fA-F]{6}", color) is None:
        raise JsonableError(_("Invalid color"))


def get_pinned_users(user_profile: UserProfile) -> list[dict[str, Any]]:
    return [
        {"user_id": user_id, "color": color}
        for user_id, color in CalendarPinnedUser.objects.filter(user=user_profile)
        .order_by("order")
        .values_list("pinned_user_id", "color")
    ]


@transaction.atomic(durable=True)
def pin_user(user_profile: UserProfile, pinned_user: UserProfile, color: str) -> None:
    """Shows a colleague's calendar after those the user already
    pinned."""
    check_color(color)
    if pinned_user.id == user_profile.id:
        raise JsonableError(_("You cannot pin your own calendar"))
    pinned_users = CalendarPinnedUser.objects.select_for_update(no_key=True).filter(
        user=user_profile
    )
    if pinned_users.filter(pinned_user=pinned_user).exists():
        raise JsonableError(_("This calendar is already pinned"))
    last_order = pinned_users.aggregate(Max("order"))["order__max"]
    CalendarPinnedUser.objects.create(
        user=user_profile,
        pinned_user=pinned_user,
        order=0 if last_order is None else last_order + 1,
        color=color,
    )


def access_pinned_user(user_profile: UserProfile, pinned_user_id: int) -> CalendarPinnedUser:
    try:
        return CalendarPinnedUser.objects.get(user=user_profile, pinned_user_id=pinned_user_id)
    except CalendarPinnedUser.DoesNotExist:
        raise JsonableError(_("This calendar is not pinned"))


def update_pinned_user_color(user_profile: UserProfile, pinned_user_id: int, color: str) -> None:
    check_color(color)
    pinned_user = access_pinned_user(user_profile, pinned_user_id)
    pinned_user.color = color
    pinned_user.save(update_fields=["color"])


def unpin_user(user_profile: UserProfile, pinned_user_id: int) -> None:
    access_pinned_user(user_profile, pinned_user_id).delete()


def get_calendar_user_settings(user_profile: UserProfile) -> CalendarUserSettings:
    """Users who never changed their settings get an unsaved row with
    the defaults."""
    try:
        return CalendarUserSettings.objects.get(user=user_profile)
    except CalendarUserSettings.DoesNotExist:
        return CalendarUserSettings(user=user_profile)


def get_working_hours(users: list[UserProfile]) -> dict[int, dict[str, Any]]:
    """When the users work, as in Exchange's working hours: their
    work days and hours in their timezone, which is "" for users who
    did not set one."""
    settings_by_user_id = {
        user_settings.user_id: user_settings
        for user_settings in CalendarUserSettings.objects.filter(user__in=users)
    }
    working_hours = {}
    for user in users:
        user_settings = settings_by_user_id.get(user.id, CalendarUserSettings(user=user))
        working_hours[user.id] = {
            "timezone": user.timezone,
            "work_days": user_settings.work_days,
            "work_day_start_minutes": user_settings.work_day_start_minutes,
            "work_day_end_minutes": user_settings.work_day_end_minutes,
        }
    return working_hours


def calendar_user_settings_to_api_dict(user_settings: CalendarUserSettings) -> dict[str, Any]:
    return {
        "work_days": user_settings.work_days,
        "work_day_start_minutes": user_settings.work_day_start_minutes,
        "work_day_end_minutes": user_settings.work_day_end_minutes,
        "default_reminder_minutes": user_settings.default_reminder_minutes,
        "default_view": user_settings.default_view,
        "time_scale_minutes": user_settings.time_scale_minutes,
    }


@transaction.atomic(durable=True)
def update_calendar_user_settings(
    user_profile: UserProfile,
    *,
    work_days: list[int] | None = None,
    work_day_start_minutes: int | None = None,
    work_day_end_minutes: int | None = None,
    default_reminder_minutes: int | Unset | None = UNSET,
    default_view: int | None = None,
    time_scale_minutes: int | None = None,
) -> None:
    user_settings = get_calendar_user_settings(user_profile)
    if work_days is not None:
        if not work_days or not set(work_days) <= set(range(1, 8)):
            raise JsonableError(_("Invalid work days"))
        user_settings.work_days = sorted(set(work_days))
    if work_day_start_minutes is not None:
        user_settings.work_day_start_minutes = work_day_start_minutes
    if work_day_end_minutes is not None:
        user_settings.work_day_end_minutes = work_day_end_minutes
    if (
        not 0
        <= user_settings.work_day_start_minutes
        < user_settings.work_day_end_minutes
        <= MINUTES_PER_DAY
    ):
        raise JsonableError(_("Invalid work hours"))
    if not isinstance(default_reminder_minutes, Unset):
        if default_reminder_minutes is not None and default_reminder_minutes < 0:
            raise JsonableError(_("Invalid reminder"))
        user_settings.default_reminder_minutes = default_reminder_minutes
    if default_view is not None:
        if default_view not in CalendarUserSettings.View.values:
            raise JsonableError(_("Invalid view"))
        user_settings.default_view = default_view
    if time_scale_minutes is not None:
        if time_scale_minutes not in TIME_SCALE_MINUTES:
            raise JsonableError(_("Invalid time scale"))
        user_settings.time_scale_minutes = time_scale_minutes
    user_settings.save()
    event = CalendarSettingsEvent(
        settings=CalendarSettings(**calendar_user_settings_to_api_dict(user_settings))
    )
    send_event_on_commit(user_profile.realm, event, [user_profile.id])
