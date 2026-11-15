from datetime import datetime
from typing import Annotated

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.utils import translation
from django.utils.translation import gettext as _
from django.views.decorators.cache import never_cache
from pydantic import Json, StringConstraints
from pydantic_partials.sentinels import Missing, MissingType

from zerver.decorator import zulip_login_required
from zerver.lib.calendar.calls import (
    access_calendar_event_call,
    can_join_calendar_event_call,
    check_calendar_event_call,
    get_calendar_event_call,
    get_calendar_event_call_chat,
    get_calendar_event_call_url,
    join_calendar_event_call,
)
from zerver.lib.calendar.changes import (
    get_or_create_calendar_event_chat,
    add_calendar_attendees,
    cancel_calendar_event,
    create_calendar_event,
    respond_to_calendar_event,
    update_calendar_attendee_settings,
    update_calendar_event,
)
from zerver.lib.calendar.occurrences import (
    access_calendar_event_by_id,
    get_calendar_event,
    get_calendar_occurrences,
    get_free_busy,
)
from zerver.lib.calendar.user_settings import (
    calendar_user_settings_to_api_dict,
    get_calendar_user_settings,
    get_pinned_users,
    get_working_hours,
    pin_user,
    unpin_user,
    update_calendar_user_settings,
    update_pinned_user_color,
)
from zerver.lib.exceptions import JsonableError
from zerver.lib.i18n import get_and_set_request_language
from zerver.lib.request import RequestNotes
from zerver.lib.response import json_success
from zerver.lib.timestamp import timestamp_to_datetime
from zerver.lib.typed_endpoint import PathOnly, typed_endpoint
from zerver.lib.types import UNSET
from zerver.lib.users import get_inaccessible_user_ids, user_ids_to_users
from zerver.models import CalendarEvent, UserProfile
from zerver.models.calendar import CalendarResponse, CalendarShowAs
from zerver.views.video_calls import render_livekit_call_access_denied

# Like Exchange's free/busy queries.
MAX_FREE_BUSY_USERS = 100

CalendarDescription = Annotated[str, StringConstraints(max_length=settings.MAX_MESSAGE_LENGTH)]
CalendarLocation = Annotated[str, StringConstraints(max_length=CalendarEvent.MAX_LOCATION_LENGTH)]


def access_calendar_users(user_profile: UserProfile, user_ids: list[int]) -> list[UserProfile]:
    users = user_ids_to_users(user_ids, user_profile.realm, allow_deactivated=False, allow_bots=False)
    inaccessible_user_ids = get_inaccessible_user_ids(user_ids, user_profile)
    if inaccessible_user_ids:
        raise JsonableError(
            _("Invalid user ID: {user_id}").format(user_id=min(inaccessible_user_ids))
        )
    return users


def to_datetime(timestamp: int | None) -> datetime | None:
    return None if timestamp is None else timestamp_to_datetime(timestamp)


@typed_endpoint
def get_calendar_events(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    start: Json[int],
    end: Json[int],
) -> HttpResponse:
    occurrences = get_calendar_occurrences(
        user_profile, timestamp_to_datetime(start), timestamp_to_datetime(end)
    )
    return json_success(
        request, data={"events": [occurrence.to_api_dict() for occurrence in occurrences]}
    )


@typed_endpoint
def get_calendar_event_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
) -> HttpResponse:
    calendar_event, has_changed_occurrences = get_calendar_event(user_profile, calendar_event_id)
    return json_success(
        request,
        data={
            "event": calendar_event.to_api_dict(),
            "has_changed_occurrences": has_changed_occurrences,
        },
    )


@typed_endpoint
def get_calendar_free_busy(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    user_ids: Json[list[int]],
    start: Json[int],
    end: Json[int],
) -> HttpResponse:
    if len(user_ids) > MAX_FREE_BUSY_USERS:
        raise JsonableError(_("Too many users"))
    users = access_calendar_users(user_profile, user_ids)
    free_busy = get_free_busy(
        user_profile, user_ids, timestamp_to_datetime(start), timestamp_to_datetime(end)
    )
    return json_success(
        request,
        data={
            "free_busy": {
                str(user_id): [block.to_api_dict() for block in blocks]
                for user_id, blocks in free_busy.items()
            },
            "working_hours": {
                str(user_id): hours for user_id, hours in get_working_hours(users).items()
            },
        },
    )


@typed_endpoint
def create_calendar_event_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    title: str,
    start: Json[int],
    end: Json[int],
    timezone: str,
    is_all_day: Json[bool] = False,
    description: CalendarDescription = "",
    location: CalendarLocation = "",
    show_as: Json[int] = CalendarShowAs.BUSY,
    is_private: Json[bool] = False,
    rrule: str = "",
    response_requested: Json[bool] = True,
    allow_forwarding: Json[bool] = True,
    hide_attendees: Json[bool] = False,
    has_zulip_call: Json[bool] = False,
    required_attendees: Json[list[int]] | None = None,
    optional_attendees: Json[list[int]] | None = None,
) -> HttpResponse:
    event_id = create_calendar_event(
        user_profile,
        title=title,
        start=timestamp_to_datetime(start),
        end=timestamp_to_datetime(end),
        event_timezone=timezone,
        is_all_day=is_all_day,
        description=description,
        location=location,
        show_as=show_as,
        is_private=is_private,
        rrule=rrule,
        response_requested=response_requested,
        allow_forwarding=allow_forwarding,
        hide_attendees=hide_attendees,
        has_zulip_call=has_zulip_call,
        required_attendees=access_calendar_users(user_profile, required_attendees or []),
        optional_attendees=access_calendar_users(user_profile, optional_attendees or []),
    )
    return json_success(request, data={"id": event_id})


@typed_endpoint
def update_calendar_event_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
    occurrence: Json[int] | None = None,
    title: str | None = None,
    description: CalendarDescription | None = None,
    location: CalendarLocation | None = None,
    start: Json[int] | None = None,
    end: Json[int] | None = None,
    timezone: str | None = None,
    is_all_day: Json[bool] | None = None,
    show_as: Json[int] | None = None,
    is_private: Json[bool] | None = None,
    rrule: str | None = None,
    response_requested: Json[bool] | None = None,
    allow_forwarding: Json[bool] | None = None,
    hide_attendees: Json[bool] | None = None,
    has_zulip_call: Json[bool] | None = None,
    required_attendees: Json[list[int]] | None = None,
    optional_attendees: Json[list[int]] | None = None,
) -> HttpResponse:
    update_calendar_event(
        user_profile,
        calendar_event_id,
        original_start=to_datetime(occurrence),
        title=title,
        description=description,
        location=location,
        start=to_datetime(start),
        end=to_datetime(end),
        event_timezone=timezone,
        is_all_day=is_all_day,
        show_as=show_as,
        is_private=is_private,
        rrule=rrule,
        response_requested=response_requested,
        allow_forwarding=allow_forwarding,
        hide_attendees=hide_attendees,
        has_zulip_call=has_zulip_call,
        required_attendees=None
        if required_attendees is None
        else access_calendar_users(user_profile, required_attendees),
        optional_attendees=None
        if optional_attendees is None
        else access_calendar_users(user_profile, optional_attendees),
    )
    return json_success(request)


@typed_endpoint
def delete_calendar_event(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
    occurrence: Json[int] | None = None,
) -> HttpResponse:
    """The organizer cancels the event for everyone; an attendee
    removes it from their own calendar by declining it."""
    event = access_calendar_event_by_id(user_profile, calendar_event_id)
    if event.organizer_id == user_profile.id:
        cancel_calendar_event(user_profile, calendar_event_id, to_datetime(occurrence))
    else:
        respond_to_calendar_event(
            user_profile, calendar_event_id, CalendarResponse.DECLINED, to_datetime(occurrence)
        )
    return json_success(request)


@typed_endpoint
def respond_to_calendar_event_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
    response: Json[int],
    occurrence: Json[int] | None = None,
    notify_organizer: Json[bool] = True,
    message: CalendarDescription = "",
) -> HttpResponse:
    respond_to_calendar_event(
        user_profile,
        calendar_event_id,
        response,
        to_datetime(occurrence),
        notify_organizer=notify_organizer,
        message=message,
    )
    return json_success(request)


@typed_endpoint
def add_calendar_attendees_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
    user_ids: Json[list[int]],
    is_required: Json[bool] = False,
) -> HttpResponse:
    add_calendar_attendees(
        user_profile,
        calendar_event_id,
        access_calendar_users(user_profile, user_ids),
        is_required,
    )
    return json_success(request)


@typed_endpoint
def get_or_create_calendar_event_chat_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
) -> HttpResponse:
    chat = get_or_create_calendar_event_chat(user_profile, calendar_event_id)
    return json_success(request, data={"stream_id": chat.id})


@typed_endpoint
def join_calendar_event_call_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
    voice_only: Json[bool] = False,
) -> HttpResponse:
    event = access_calendar_event_call(user_profile, calendar_event_id)
    client = RequestNotes.get_notes(request).client
    assert client is not None
    url = join_calendar_event_call(user_profile, client, event, voice_only)
    return json_success(request, data={"url": url})


# The permanent link to a meeting's call, for invitations. It joins
# the call if it is taking place; starting it takes a click, so that
# opening the link cannot post to the meeting's chat by itself.
@zulip_login_required
@never_cache
@typed_endpoint
def meet_calendar_event(
    request: HttpRequest,
    *,
    meet_code: PathOnly[str],
    voice_only: Json[bool] = False,
) -> HttpResponse:
    assert request.user.is_authenticated
    user_profile = request.user
    get_and_set_request_language(
        request,
        user_profile.default_language,
        translation.get_language_from_path(request.path_info),
    )

    event = (
        CalendarEvent.objects.filter(realm_id=user_profile.realm_id, meet_code=meet_code)
        .select_related("realm", "chat")
        .first()
    )
    if event is None or not can_join_calendar_event_call(user_profile, event):
        return render_livekit_call_access_denied(request)
    try:
        check_calendar_event_call(event)
    except JsonableError as e:
        return render(
            request,
            "zerver/portico_error_pages/calendar_meeting_without_call.html",
            context={"event_title": event.title, "reason": e.msg},
            status=404,
        )

    if request.method == "POST":
        client = RequestNotes.get_notes(request).client
        assert client is not None
        return redirect(join_calendar_event_call(user_profile, client, event, voice_only))

    call = None if event.chat is None else get_calendar_event_call(event.chat)
    if call is not None:
        # Attendees who left the meeting's chat join it again to join
        # its call.
        get_calendar_event_call_chat(user_profile, event)
        return redirect(get_calendar_event_call_url(call, voice_only))
    return render(
        request,
        "zerver/calendar_meet.html",
        context={"event_title": event.title, "voice_only": voice_only},
    )


@typed_endpoint
def update_calendar_personal_settings(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    calendar_event_id: PathOnly[int],
    reminder_minutes: Json[int | None] | MissingType = Missing,
    category: str | None = None,
    show_as: Json[int | None] | MissingType = Missing,
) -> HttpResponse:
    update_calendar_attendee_settings(
        user_profile,
        calendar_event_id,
        reminder_minutes=UNSET if isinstance(reminder_minutes, MissingType) else reminder_minutes,
        category=category,
        show_as=UNSET if isinstance(show_as, MissingType) else show_as,
    )
    return json_success(request)


def get_calendar_pinned_users(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    return json_success(request, data={"pinned_users": get_pinned_users(user_profile)})


@typed_endpoint
def pin_calendar_user(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    user_id: Json[int],
    color: str,
) -> HttpResponse:
    (pinned_user,) = access_calendar_users(user_profile, [user_id])
    pin_user(user_profile, pinned_user, color)
    return json_success(request)


@typed_endpoint
def update_calendar_pinned_user(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    user_id: PathOnly[int],
    color: str,
) -> HttpResponse:
    update_pinned_user_color(user_profile, user_id, color)
    return json_success(request)


@typed_endpoint
def unpin_calendar_user(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    user_id: PathOnly[int],
) -> HttpResponse:
    unpin_user(user_profile, user_id)
    return json_success(request)


def get_calendar_settings(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    user_settings = get_calendar_user_settings(user_profile)
    return json_success(
        request, data={"settings": calendar_user_settings_to_api_dict(user_settings)}
    )


@typed_endpoint
def update_calendar_settings(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    work_days: Json[list[int]] | None = None,
    work_day_start_minutes: Json[int] | None = None,
    work_day_end_minutes: Json[int] | None = None,
    default_reminder_minutes: Json[int | None] | MissingType = Missing,
    default_view: Json[int] | None = None,
    time_scale_minutes: Json[int] | None = None,
) -> HttpResponse:
    update_calendar_user_settings(
        user_profile,
        work_days=work_days,
        work_day_start_minutes=work_day_start_minutes,
        work_day_end_minutes=work_day_end_minutes,
        default_reminder_minutes=UNSET
        if isinstance(default_reminder_minutes, MissingType)
        else default_reminder_minutes,
        default_view=default_view,
        time_scale_minutes=time_scale_minutes,
    )
    return json_success(request)
