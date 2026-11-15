from collections.abc import Callable
from datetime import datetime

from django.conf import settings
from django.utils.translation import gettext as _
from django.utils.translation import override as override_language

from zerver.actions.message_send import do_send_messages, internal_prep_private_message
from zerver.lib.mention import silent_mention_syntax_for_user
from zerver.lib.timestamp import datetime_to_global_time
from zerver.models import CalendarEvent, CalendarEventException, UserProfile
from zerver.models.calendar import CalendarResponse
from zerver.models.users import get_system_bot

# Invitations, changes of time, cancellations and responses reach
# people as direct messages from Notification Bot, which mobile apps
# notify of too.


def get_calendar_event_url(event: CalendarEvent, start: datetime) -> str:
    # Times passed in may be in any time zone.
    return f"{event.realm.url}/#calendar/event/{event.id}/{int(start.timestamp())}"


def send_calendar_notifications(
    actor: UserProfile,
    event: CalendarEvent,
    user_ids: set[int],
    start: datetime,
    get_text: Callable[[], str],
) -> None:
    """Sends get_text, in each user's language, with a link to the
    occurrence of the event at start; never to the person acting."""
    users = UserProfile.objects.filter(
        id__in=user_ids - {actor.id}, realm_id=event.realm_id, is_active=True
    )
    bot = get_system_bot(settings.NOTIFICATION_BOT, event.realm_id)
    url = get_calendar_event_url(event, start)
    requests = []
    for user in users:
        with override_language(user.default_language):
            content = "{text} [{link}]({url})".format(
                text=get_text(), link=_("Open in calendar"), url=url
            )
        requests.append(internal_prep_private_message(bot, user, content))
    do_send_messages(requests)


def format_title(title: str, occurrence_start: datetime | None = None) -> str:
    """The title, and for one occurrence of a series, when it takes
    place, in each reader's time zone."""
    if occurrence_start is None:
        return f"**{title}**"
    return f"**{title}** ({datetime_to_global_time(occurrence_start)})"


def notify_invited(actor: UserProfile, event: CalendarEvent, user_ids: set[int]) -> None:
    send_calendar_notifications(
        actor,
        event,
        user_ids,
        event.start,
        lambda: _("{user} invited you to {title} on {time}.").format(
            user=silent_mention_syntax_for_user(actor),
            title=format_title(event.title),
            time=datetime_to_global_time(event.start),
        ),
    )


def notify_removed(actor: UserProfile, event: CalendarEvent, user_ids: set[int]) -> None:
    send_calendar_notifications(
        actor,
        event,
        user_ids,
        event.start,
        lambda: _("{user} removed you from {title}.").format(
            user=silent_mention_syntax_for_user(actor), title=format_title(event.title)
        ),
    )


def notify_moved(
    actor: UserProfile,
    event: CalendarEvent,
    user_ids: set[int],
    exception: CalendarEventException | None = None,
) -> None:
    title = event.title
    original_start = None
    start = event.start
    if exception is not None:
        title = exception.title or event.title
        original_start = exception.original_start
        start = exception.start or exception.original_start
    send_calendar_notifications(
        actor,
        event,
        user_ids,
        start,
        lambda: _("{user} moved {title} to {time}.").format(
            user=silent_mention_syntax_for_user(actor),
            title=format_title(title, original_start),
            time=datetime_to_global_time(start),
        ),
    )


def notify_cancelled(
    actor: UserProfile,
    event: CalendarEvent,
    user_ids: set[int],
    exception: CalendarEventException | None = None,
) -> None:
    title = event.title
    start = event.start
    if exception is not None:
        title = exception.title or event.title
        start = exception.start or exception.original_start
    send_calendar_notifications(
        actor,
        event,
        user_ids,
        start,
        lambda: _("{user} cancelled {title}.").format(
            user=silent_mention_syntax_for_user(actor),
            title=format_title(title, None if exception is None else start),
        ),
    )


def notify_response(
    attendee: UserProfile,
    event: CalendarEvent,
    response: int,
    original_start: datetime | None,
    message: str,
) -> None:
    start = original_start or event.start

    def get_text() -> str:
        if response == CalendarResponse.ACCEPTED:
            text = _("{user} accepted {title}.")
        elif response == CalendarResponse.TENTATIVE:
            text = _("{user} tentatively accepted {title}.")
        else:
            text = _("{user} declined {title}.")
        text = text.format(
            user=silent_mention_syntax_for_user(attendee),
            title=format_title(event.title, original_start),
        )
        if message:
            quoted = "\n".join(f"> {line}" for line in message.splitlines())
            text += f"\n\n{quoted}\n\n"
        return text

    send_calendar_notifications(attendee, event, {event.organizer_id}, start, get_text)
