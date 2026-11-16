import zoneinfo

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils.translation import gettext as _

from zerver.lib.calendar.occurrences import get_first_room_conflict
from zerver.lib.exceptions import JsonableError
from zerver.lib.types import UNSET, Unset
from zerver.models import CalendarEvent, CalendarEventRoom, CalendarRoom, Realm


def calendar_room_to_api_dict(room: CalendarRoom) -> dict[str, object]:
    return {
        "id": room.id,
        "name": room.name,
        "capacity": room.capacity,
        "location": room.location,
        "email": room.email,
        "is_archived": room.is_archived,
    }


def get_calendar_rooms(realm: Realm) -> list[dict[str, object]]:
    """All the rooms of the organization, including archived ones,
    which meetings that booked them still show."""
    return [
        calendar_room_to_api_dict(room)
        for room in CalendarRoom.objects.filter(realm=realm).order_by("name", "id")
    ]


def check_room_name(realm: Realm, name: str, room_id: int | None = None) -> str:
    name = name.strip()
    if not name:
        raise JsonableError(_("The name must not be empty"))
    if len(name) > CalendarRoom.MAX_NAME_LENGTH:
        raise JsonableError(_("The name is too long"))
    rooms = CalendarRoom.objects.filter(realm=realm, name__iexact=name)
    if room_id is not None:
        rooms = rooms.exclude(id=room_id)
    if rooms.exists():
        raise JsonableError(_("A meeting room with this name already exists"))
    return name


def check_room_capacity(capacity: int | None) -> None:
    if capacity is not None and capacity < 1:
        raise JsonableError(_("Invalid capacity"))


def check_room_email(email: str) -> str:
    email = email.strip()
    if email:
        try:
            validate_email(email)
        except ValidationError:
            raise JsonableError(_("Invalid email address"))
    return email


def create_calendar_room(
    realm: Realm, *, name: str, capacity: int | None, location: str, email: str
) -> int:
    check_room_capacity(capacity)
    room = CalendarRoom.objects.create(
        realm=realm,
        name=check_room_name(realm, name),
        capacity=capacity,
        location=location.strip(),
        email=check_room_email(email),
    )
    return room.id


def access_calendar_room(realm: Realm, room_id: int) -> CalendarRoom:
    try:
        return CalendarRoom.objects.get(id=room_id, realm=realm)
    except CalendarRoom.DoesNotExist:
        raise JsonableError(_("Invalid meeting room"))


def update_calendar_room(
    room: CalendarRoom,
    *,
    name: str | None = None,
    capacity: int | Unset | None = UNSET,
    location: str | None = None,
    email: str | None = None,
    is_archived: bool | None = None,
) -> None:
    if name is not None:
        room.name = check_room_name(room.realm, name, room.id)
    if not isinstance(capacity, Unset):
        check_room_capacity(capacity)
        room.capacity = capacity
    if location is not None:
        room.location = location.strip()
    if email is not None:
        room.email = check_room_email(email)
    if is_archived is not None:
        room.is_archived = is_archived
    room.save()


def check_calendar_event_rooms(
    realm: Realm, room_ids: list[int], event: CalendarEvent | None = None
) -> bool:
    """Checks that the rooms may be booked by the event, and returns
    whether they differ from those it booked. Archived rooms can no
    longer be booked, but the event keeps those it booked."""
    booked_room_ids = (
        set()
        if event is None
        else set(CalendarEventRoom.objects.filter(event=event).values_list("room_id", flat=True))
    )
    rooms = CalendarRoom.objects.filter(realm=realm, id__in=room_ids)
    if len(rooms) != len(set(room_ids)) or any(
        room.is_archived and room.id not in booked_room_ids for room in rooms
    ):
        raise JsonableError(_("Invalid meeting room"))
    return set(room_ids) != booked_room_ids


def set_calendar_event_rooms(event: CalendarEvent, room_ids: list[int]) -> None:
    CalendarEventRoom.objects.filter(event=event).exclude(room_id__in=room_ids).delete()
    booked_room_ids = set(
        CalendarEventRoom.objects.filter(event=event).values_list("room_id", flat=True)
    )
    CalendarEventRoom.objects.bulk_create(
        CalendarEventRoom(event=event, room_id=room_id)
        for room_id in set(room_ids) - booked_room_ids
    )


def check_calendar_event_rooms_free(event: CalendarEvent) -> None:
    """A room accepts a booking only if it is free during all the
    occurrences of the meeting, as a room mailbox in Exchange does.

    The rooms are locked until the transaction ends, so that of two
    meetings booking a room at once, the second sees the first."""
    rooms = {
        room.id: room
        for room in CalendarRoom.objects.select_for_update(no_key=True)
        .filter(calendareventroom__event=event)
        .order_by("id")
    }
    if not rooms:
        return
    conflict = get_first_room_conflict(event, list(rooms))
    if conflict is not None:
        room_id, start = conflict
        raise JsonableError(
            _("{room_name} is booked for another meeting at {time}.").format(
                room_name=rooms[room_id].name,
                time=start.astimezone(zoneinfo.ZoneInfo(event.timezone)).strftime("%Y-%m-%d %H:%M"),
            )
        )
