from collections import defaultdict
from collections.abc import Collection, Iterable
from dataclasses import asdict, dataclass

from django.db import transaction
from django.db.models import Q
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _

from zerver.actions.streams import bulk_remove_subscriptions, rename_stream_without_notice
from zerver.lib.channel_folders import get_channel_folders_data, render_channel_folder_description
from zerver.lib.event_types import (
    ChannelFolderAddEvent,
    ChannelFolderDataForUpdate,
    ChannelFolderForChannelFolderAddEvent,
    ChannelFolderRemoveEvent,
    ChannelFolderReorderEvent,
    ChannelFolderUpdateEvent,
    SubscriptionPeerAddEvent,
)
from zerver.lib.exceptions import JsonableError
from zerver.lib.stream_subscription import get_user_ids_for_streams
from zerver.lib.streams import (
    bulk_can_access_stream_metadata_user_ids,
    get_anonymous_group_membership_dict_for_streams,
    get_channel_folder_audience_user_ids,
    get_qualified_channel_name,
    get_short_channel_name,
    send_stream_creation_event,
    send_stream_deletion_event,
)
from zerver.lib.types import UserGroupMembersData
from zerver.lib.user_groups import (
    convert_to_user_group_members_dict,
    get_group_setting_value_for_api,
    get_group_setting_value_for_audit_log_data,
    get_system_user_group_by_name,
    update_or_create_user_group_for_setting,
)
from zerver.models import (
    ChannelFolder,
    NamedUserGroup,
    Realm,
    RealmAuditLog,
    Stream,
    UserGroup,
    UserGroupMembership,
    UserProfile,
)
from zerver.models.groups import SystemGroups
from zerver.models.realm_audit_logs import AuditLogEventType
from zerver.tornado.django_api import send_event_on_commit


@dataclass
class ChannelFolderAudiences:
    """Who could see some channel folders and their channels, before a
    change that can change it.
    """

    realm: Realm
    channel_folders: list[ChannelFolder]
    folder_user_ids: dict[int, set[int]]
    channels: list[Stream]
    channel_user_ids: dict[int, set[int]]


def get_channel_folder_audiences(
    realm: Realm, channel_folders: Collection[ChannelFolder]
) -> ChannelFolderAudiences:
    channel_folders = list(channel_folders)
    if len(channel_folders) == 0:
        return ChannelFolderAudiences(realm, [], {}, [], {})
    channels = list(Stream.objects.filter(folder__in=channel_folders).select_related("folder"))
    return ChannelFolderAudiences(
        realm=realm,
        channel_folders=channel_folders,
        folder_user_ids=get_channel_folder_audience_user_ids(channel_folders, realm.id),
        channels=channels,
        channel_user_ids=bulk_can_access_stream_metadata_user_ids(channels),
    )


def get_channel_folders_using_groups(
    realm: Realm, group_ids: Collection[int]
) -> list[ChannelFolder]:
    return list(
        ChannelFolder.objects.filter(realm=realm).filter(
            Q(can_access_group_id__in=group_ids) | Q(can_administer_group_id__in=group_ids)
        )
    )


def update_access_to_channel_folders(
    old_audiences: ChannelFolderAudiences, *, acting_user: UserProfile | None
) -> None:
    """Tells users who became able or unable to see the folders, and
    their channels. Users who can no longer see a folder are
    unsubscribed from its channels, which also closes these channels in
    their clients and stops delivering messages to them.
    """
    realm = old_audiences.realm
    if len(old_audiences.channel_folders) == 0:
        return

    new_folder_user_ids = get_channel_folder_audience_user_ids(
        old_audiences.channel_folders, realm.id
    )
    gained_folder_user_ids = {
        folder_id: user_ids - old_audiences.folder_user_ids[folder_id]
        for folder_id, user_ids in new_folder_user_ids.items()
    }
    lost_folder_user_ids = {
        folder_id: old_audiences.folder_user_ids[folder_id] - user_ids
        for folder_id, user_ids in new_folder_user_ids.items()
    }

    # Clients learn about a folder before the channels in it, and
    # forget it after them.
    for channel_folder in old_audiences.channel_folders:
        if gained_folder_user_ids[channel_folder.id]:
            send_channel_folder_add_event(channel_folder, gained_folder_user_ids[channel_folder.id])

    unsubscribed: set[tuple[int, int]] = set()
    channels_by_folder: dict[int, list[Stream]] = defaultdict(list)
    for channel in old_audiences.channels:
        assert channel.folder_id is not None
        channels_by_folder[channel.folder_id].append(channel)
    for folder_id, channels in channels_by_folder.items():
        if lost_folder_user_ids[folder_id]:
            removed, _not_subscribed = bulk_remove_subscriptions(
                realm,
                UserProfile.objects.filter(id__in=lost_folder_user_ids[folder_id]),
                channels,
                acting_user=acting_user,
            )
            unsubscribed |= {(user.id, channel.id) for user, channel in removed}

    if old_audiences.channels:
        new_channel_user_ids = bulk_can_access_stream_metadata_user_ids(old_audiences.channels)
        subscriber_ids = get_user_ids_for_streams(
            {channel.id for channel in old_audiences.channels}
        )
        anonymous_group_membership = get_anonymous_group_membership_dict_for_streams(
            old_audiences.channels
        )
        for channel in old_audiences.channels:
            old_user_ids = old_audiences.channel_user_ids[channel.id]
            new_user_ids = new_channel_user_ids[channel.id]
            # Unsubscribing already told those who were subscribed.
            user_ids_losing_access = {
                user_id
                for user_id in old_user_ids - new_user_ids
                if (user_id, channel.id) not in unsubscribed
            }
            if user_ids_losing_access:
                send_stream_deletion_event(realm, user_ids_losing_access, [channel])
            user_ids_gaining_access = new_user_ids - old_user_ids
            if user_ids_gaining_access:
                send_stream_creation_event(
                    realm,
                    channel,
                    list(user_ids_gaining_access),
                    anonymous_group_membership=anonymous_group_membership,
                )
                send_event_on_commit(
                    realm,
                    SubscriptionPeerAddEvent(
                        stream_ids=[channel.id], user_ids=sorted(subscriber_ids[channel.id])
                    ),
                    user_ids_gaining_access,
                )

    for channel_folder in old_audiences.channel_folders:
        if lost_folder_user_ids[channel_folder.id]:
            send_event_on_commit(
                realm,
                ChannelFolderRemoveEvent(channel_folder_id=channel_folder.id),
                lost_folder_user_ids[channel_folder.id],
            )


@transaction.atomic(durable=True)
def check_add_channel_folder(
    realm: Realm,
    name: str,
    description: str,
    *,
    acting_user: UserProfile,
    can_access_group: NamedUserGroup | UserGroupMembersData | None = None,
) -> ChannelFolder:
    rendered_description = render_channel_folder_description(
        description, realm, acting_user=acting_user
    )
    # The creator is the first administrator of the folder.
    can_administer_group = UserGroup.objects.create(realm=realm)
    UserGroupMembership.objects.create(user_profile=acting_user, user_group=can_administer_group)

    access_group: UserGroup
    if can_access_group is None:
        access_group = get_system_user_group_by_name(SystemGroups.EVERYONE, realm.id)
    elif isinstance(can_access_group, UserGroupMembersData):
        access_group = update_or_create_user_group_for_setting(
            acting_user,
            can_access_group.direct_members,
            can_access_group.direct_subgroups,
            None,
        )
    else:
        access_group = can_access_group

    channel_folder = ChannelFolder.objects.create(
        realm=realm,
        name=name,
        description=description,
        rendered_description=rendered_description,
        creator_id=acting_user.id,
        can_administer_group=can_administer_group,
        can_access_group=access_group,
    )
    channel_folder.order = channel_folder.id
    channel_folder.save(update_fields=["order"])

    creation_time = timezone_now()
    RealmAuditLog.objects.create(
        realm=realm,
        acting_user=acting_user,
        event_type=AuditLogEventType.CHANNEL_FOLDER_CREATED,
        event_time=creation_time,
        modified_channel_folder=channel_folder,
    )

    send_channel_folder_add_event(
        channel_folder,
        get_channel_folder_audience_user_ids([channel_folder], realm.id)[channel_folder.id],
    )

    return channel_folder


def send_channel_folder_add_event(channel_folder: ChannelFolder, user_ids: Iterable[int]) -> None:
    event = ChannelFolderAddEvent(
        channel_folder=ChannelFolderForChannelFolderAddEvent(
            **asdict(get_channel_folders_data([channel_folder])[0])
        ),
    )
    send_event_on_commit(channel_folder.realm, event, user_ids)


@transaction.atomic(durable=True)
def try_reorder_realm_channel_folders(realm: Realm, order: list[int]) -> None:
    order_mapping = {_[1]: _[0] for _ in enumerate(order)}
    channel_folders = ChannelFolder.objects.filter(realm=realm)
    for channel_folder in channel_folders:
        if channel_folder.id not in order_mapping:
            raise JsonableError(_("Invalid order mapping."))
    for channel_folder in channel_folders:
        channel_folder.order = order_mapping[channel_folder.id]
        channel_folder.save(update_fields=["order"])

    # Each user gets the order of the folders they can see.
    audience_user_ids = get_channel_folder_audience_user_ids(channel_folders, realm.id)
    visible_folder_ids: dict[int, list[int]] = defaultdict(list)
    for folder_id in order:
        for user_id in audience_user_ids.get(folder_id, set()):
            visible_folder_ids[user_id].append(folder_id)
    user_ids_by_order: dict[tuple[int, ...], list[int]] = defaultdict(list)
    for user_id, folder_ids in visible_folder_ids.items():
        user_ids_by_order[tuple(folder_ids)].append(user_id)
    for visible_order, user_ids in user_ids_by_order.items():
        send_event_on_commit(realm, ChannelFolderReorderEvent(order=list(visible_order)), user_ids)


def do_send_channel_folder_update_event(
    channel_folder: ChannelFolder, data: ChannelFolderDataForUpdate
) -> None:
    realm = channel_folder.realm
    event = ChannelFolderUpdateEvent(channel_folder_id=channel_folder.id, data=data)
    send_event_on_commit(
        realm,
        event,
        get_channel_folder_audience_user_ids([channel_folder], realm.id)[channel_folder.id],
    )


@transaction.atomic(durable=True)
def do_change_channel_folder_name(
    channel_folder: ChannelFolder, name: str, *, acting_user: UserProfile
) -> None:
    old_value = channel_folder.name
    channels = list(Stream.objects.filter(folder=channel_folder).select_related("realm"))
    short_channel_names = {
        channel.id: get_short_channel_name(channel.name, channel_folder) for channel in channels
    }
    channel_folder.name = name
    channel_folder.save(update_fields=["name"])

    RealmAuditLog.objects.create(
        realm=acting_user.realm,
        acting_user=acting_user,
        event_type=AuditLogEventType.CHANNEL_FOLDER_NAME_CHANGED,
        event_time=timezone_now(),
        modified_channel_folder=channel_folder,
        extra_data={
            RealmAuditLog.OLD_VALUE: old_value,
            RealmAuditLog.NEW_VALUE: name,
        },
    )

    do_send_channel_folder_update_event(channel_folder, ChannelFolderDataForUpdate(name=name))

    notify_user_ids = bulk_can_access_stream_metadata_user_ids(channels)
    for channel in channels:
        rename_stream_without_notice(
            channel,
            get_qualified_channel_name(short_channel_names[channel.id], channel_folder),
            acting_user=acting_user,
            notify_user_ids=notify_user_ids[channel.id],
        )


@transaction.atomic(durable=True)
def do_change_channel_folder_description(
    channel_folder: ChannelFolder, description: str, *, acting_user: UserProfile
) -> None:
    old_value = channel_folder.description
    rendered_description = render_channel_folder_description(
        description, acting_user.realm, acting_user=acting_user
    )
    channel_folder.description = description
    channel_folder.rendered_description = rendered_description
    channel_folder.save(update_fields=["description", "rendered_description"])

    RealmAuditLog.objects.create(
        realm=acting_user.realm,
        acting_user=acting_user,
        event_type=AuditLogEventType.CHANNEL_FOLDER_DESCRIPTION_CHANGED,
        event_time=timezone_now(),
        modified_channel_folder=channel_folder,
        extra_data={
            RealmAuditLog.OLD_VALUE: old_value,
            RealmAuditLog.NEW_VALUE: description,
        },
    )

    do_send_channel_folder_update_event(
        channel_folder,
        ChannelFolderDataForUpdate(
            description=description, rendered_description=rendered_description
        ),
    )


@transaction.atomic(durable=True)
def do_archive_channel_folder(channel_folder: ChannelFolder, *, acting_user: UserProfile) -> None:
    channel_folder.is_archived = True
    channel_folder.save(update_fields=["is_archived"])

    RealmAuditLog.objects.create(
        realm=acting_user.realm,
        acting_user=acting_user,
        event_type=AuditLogEventType.CHANNEL_FOLDER_ARCHIVED,
        event_time=timezone_now(),
        modified_channel_folder=channel_folder,
    )

    do_send_channel_folder_update_event(
        channel_folder, ChannelFolderDataForUpdate(is_archived=True)
    )


@transaction.atomic(durable=True)
def do_unarchive_channel_folder(channel_folder: ChannelFolder, *, acting_user: UserProfile) -> None:
    channel_folder.is_archived = False
    channel_folder.save(update_fields=["is_archived"])

    RealmAuditLog.objects.create(
        realm=acting_user.realm,
        acting_user=acting_user,
        event_type=AuditLogEventType.CHANNEL_FOLDER_UNARCHIVED,
        event_time=timezone_now(),
        modified_channel_folder=channel_folder,
    )

    do_send_channel_folder_update_event(
        channel_folder, ChannelFolderDataForUpdate(is_archived=False)
    )


@transaction.atomic(savepoint=False)
def do_change_channel_folder_group_based_setting(
    channel_folder: ChannelFolder,
    setting_name: str,
    new_setting_value: NamedUserGroup | UserGroupMembersData,
    *,
    acting_user: UserProfile,
) -> None:
    old_user_group = getattr(channel_folder, setting_name)
    old_setting_api_value = get_group_setting_value_for_api(old_user_group)
    realm = acting_user.realm
    old_audiences = get_channel_folder_audiences(realm, [channel_folder])

    if isinstance(new_setting_value, NamedUserGroup):
        user_group: UserGroup = new_setting_value
    else:
        user_group = update_or_create_user_group_for_setting(
            acting_user,
            new_setting_value.direct_members,
            new_setting_value.direct_subgroups,
            old_user_group,
        )

    setattr(channel_folder, setting_name, user_group)
    channel_folder.save(update_fields=[setting_name])

    new_setting_api_value = get_group_setting_value_for_api(user_group)
    RealmAuditLog.objects.create(
        realm=acting_user.realm,
        acting_user=acting_user,
        event_type=AuditLogEventType.CHANNEL_FOLDER_GROUP_BASED_SETTING_CHANGED,
        event_time=timezone_now(),
        modified_channel_folder=channel_folder,
        extra_data={
            RealmAuditLog.OLD_VALUE: get_group_setting_value_for_audit_log_data(
                old_setting_api_value
            ),
            RealmAuditLog.NEW_VALUE: get_group_setting_value_for_audit_log_data(
                new_setting_api_value
            ),
            "property": setting_name,
        },
    )

    # Who can see the folder can change with either setting.
    new_audience_user_ids = get_channel_folder_audience_user_ids([channel_folder], realm.id)[
        channel_folder.id
    ]
    event = ChannelFolderUpdateEvent(
        channel_folder_id=channel_folder.id,
        data=ChannelFolderDataForUpdate.model_validate(
            {setting_name: convert_to_user_group_members_dict(new_setting_api_value)}
        ),
    )
    send_event_on_commit(
        realm, event, old_audiences.folder_user_ids[channel_folder.id] & new_audience_user_ids
    )
    update_access_to_channel_folders(old_audiences, acting_user=acting_user)
