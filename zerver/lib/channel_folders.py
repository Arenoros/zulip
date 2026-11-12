from collections.abc import Collection
from dataclasses import dataclass

from django.utils.translation import gettext as _

from zerver.lib.exceptions import CannotAdministerChannelError, ChannelExistsError, JsonableError
from zerver.lib.markdown import markdown_convert
from zerver.lib.streams import (
    get_channel_folder_access_query,
    get_short_channel_name,
    get_web_public_streams_queryset,
    is_channel_folder_private,
    user_can_administer_channel_folder,
)
from zerver.lib.string_validation import check_string_is_printable
from zerver.lib.timestamp import datetime_to_timestamp
from zerver.lib.types import UserGroupMembersData, UserGroupMembersDict
from zerver.lib.user_groups import (
    get_group_setting_value_for_register_api,
    get_members_and_subgroups_of_groups,
)
from zerver.models import ChannelFolder, DefaultStream, Realm, Stream, UserGroup, UserProfile
from zerver.models.streams import bulk_get_streams


@dataclass
class ChannelFolderData:
    id: int
    name: str
    description: str
    rendered_description: str
    order: int
    creator_id: int | None
    date_created: int
    is_archived: bool
    can_administer_group: int | UserGroupMembersDict
    can_access_group: int | UserGroupMembersDict


def check_channel_folder_name(name: str, realm: Realm) -> None:
    if name.strip() == "":
        raise JsonableError(_("Channel folder name can't be empty."))

    if "/" in name:
        raise JsonableError(_("Channel folder name can't contain '/'."))

    invalid_character_pos = check_string_is_printable(name)
    if invalid_character_pos is not None:
        raise JsonableError(
            _("Invalid character in channel folder name, at position {position}.").format(
                position=invalid_character_pos
            )
        )

    if ChannelFolder.objects.filter(name__iexact=name, realm=realm, is_archived=False).exists():
        raise JsonableError(_("Channel folder name already in use"))


def check_channel_names_available_for_folder_name(channel_folder: ChannelFolder, name: str) -> None:
    """Renaming a folder renames the channels in it."""
    new_channel_names = {
        f"{name}/{get_short_channel_name(channel_name, channel_folder)}"
        for channel_name in Stream.objects.filter(folder=channel_folder).values_list(
            "name", flat=True
        )
    }
    for channel in bulk_get_streams(channel_folder.realm, new_channel_names).values():
        if channel.folder_id != channel_folder.id:
            raise ChannelExistsError(channel.name)


def render_channel_folder_description(text: str, realm: Realm, *, acting_user: UserProfile) -> str:
    return markdown_convert(
        text, message_realm=realm, no_previews=True, acting_user=acting_user
    ).rendered_content


def get_anonymous_group_membership_dict_for_channel_folders(
    channel_folders: Collection[ChannelFolder],
) -> dict[int, UserGroupMembersData]:
    setting_group_ids = {
        getattr(channel_folder, setting_name + "_id")
        for channel_folder in channel_folders
        for setting_name in ChannelFolder.channel_folder_permission_group_settings
    }
    anonymous_group_ids = UserGroup.objects.filter(
        id__in=setting_group_ids, named_user_group=None
    ).values_list("id", flat=True)
    if len(anonymous_group_ids) == 0:
        return {}

    return get_members_and_subgroups_of_groups(anonymous_group_ids)


def get_channel_folder_data(
    channel_folder: ChannelFolder,
    anonymous_group_membership: dict[int, UserGroupMembersData],
) -> ChannelFolderData:
    date_created = datetime_to_timestamp(channel_folder.date_created)
    return ChannelFolderData(
        id=channel_folder.id,
        name=channel_folder.name,
        description=channel_folder.description,
        rendered_description=channel_folder.rendered_description,
        order=channel_folder.order,
        date_created=date_created,
        creator_id=channel_folder.creator_id,
        is_archived=channel_folder.is_archived,
        can_administer_group=get_group_setting_value_for_register_api(
            channel_folder.can_administer_group_id, anonymous_group_membership
        ),
        can_access_group=get_group_setting_value_for_register_api(
            channel_folder.can_access_group_id, anonymous_group_membership
        ),
    )


def get_channel_folders_data(channel_folders: Collection[ChannelFolder]) -> list[ChannelFolderData]:
    anonymous_group_membership = get_anonymous_group_membership_dict_for_channel_folders(
        channel_folders
    )
    return [
        get_channel_folder_data(channel_folder, anonymous_group_membership)
        for channel_folder in channel_folders
    ]


def get_channel_folders_for_user(
    user_profile: UserProfile, include_archived: bool = False
) -> list[ChannelFolderData]:
    folders = ChannelFolder.objects.filter(realm_id=user_profile.realm_id).filter(
        get_channel_folder_access_query(user_profile)
    )
    if not include_archived:
        folders = folders.exclude(is_archived=True)

    return sorted(get_channel_folders_data(folders), key=lambda folder: folder.order)


def get_channel_folder_by_id(channel_folder_id: int, realm: Realm) -> ChannelFolder:
    try:
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id, realm=realm)
        return channel_folder
    except ChannelFolder.DoesNotExist:
        raise JsonableError(_("Invalid channel folder ID"))


def access_channel_folder_for_administration(
    channel_folder_id: int, user_profile: UserProfile
) -> ChannelFolder:
    channel_folder = get_channel_folder_by_id(channel_folder_id, user_profile.realm)
    if not user_can_administer_channel_folder(user_profile, channel_folder):
        raise JsonableError(_("Insufficient permission"))
    return channel_folder


def check_can_move_channel_to_folder(
    user_profile: UserProfile,
    channel: Stream,
    new_folder: ChannelFolder | None,
    *,
    can_administer_channel: bool,
) -> None:
    """Moving a channel is up to the administrators of the folders it
    moves between, since they decide what is in their folders. A
    channel that is in no folder is moved by those who administer the
    channel.
    """
    old_folder = channel.folder
    if old_folder is None:
        if not can_administer_channel:
            raise CannotAdministerChannelError
    elif not user_can_administer_channel_folder(user_profile, old_folder):
        raise JsonableError(_("Insufficient permission"))

    if new_folder is not None and not user_can_administer_channel_folder(user_profile, new_folder):
        raise JsonableError(_("Insufficient permission"))


def check_channel_can_be_in_folder(
    channel_folder: ChannelFolder | None, *, is_web_public: bool, is_default_stream: bool
) -> None:
    """Channels that everyone can see cannot be in a private folder,
    like they cannot be private channels.
    """
    if channel_folder is None or not (is_web_public or is_default_stream):
        return
    if not is_channel_folder_private(channel_folder):
        return
    if is_web_public:
        raise JsonableError(_("Web-public channels cannot be in a private channel folder."))
    raise JsonableError(_("Default channels cannot be in a private channel folder."))


def check_channel_folder_can_be_private(channel_folder: ChannelFolder) -> None:
    if Stream.objects.filter(folder=channel_folder, is_web_public=True).exists():
        raise JsonableError(_("A channel folder with web-public channels cannot be private."))
    if DefaultStream.objects.filter(stream__folder=channel_folder).exists():
        raise JsonableError(_("A channel folder with default channels cannot be private."))


def get_channel_folders_for_spectators(realm: Realm) -> list[ChannelFolderData]:
    folder_ids_for_web_public_streams = set(
        get_web_public_streams_queryset(realm).values_list("folder_id", flat=True)
    )
    folders = ChannelFolder.objects.filter(id__in=folder_ids_for_web_public_streams)
    return sorted(get_channel_folders_data(folders), key=lambda folder: folder.id)


def check_channel_folder_in_use(channel_folder: ChannelFolder) -> bool:
    if Stream.objects.filter(folder=channel_folder).exists():
        return True
    return False
