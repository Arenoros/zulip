from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils.translation import gettext as _

from zerver.lib.exceptions import JsonableError
from zerver.lib.types import UNSET, Unset
from zerver.models import CalendarRoom, Realm


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
