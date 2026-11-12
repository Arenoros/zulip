from dataclasses import asdict

from django.db import transaction
from django.utils.timezone import now as timezone_now
from django.utils.translation import gettext as _

from zerver.actions.streams import rename_stream_without_notice
from zerver.lib.channel_folders import get_channel_folders_data, render_channel_folder_description
from zerver.lib.event_types import (
    ChannelFolderAddEvent,
    ChannelFolderDataForUpdate,
    ChannelFolderForChannelFolderAddEvent,
    ChannelFolderReorderEvent,
    ChannelFolderUpdateEvent,
)
from zerver.lib.exceptions import JsonableError
from zerver.lib.streams import (
    bulk_can_access_stream_metadata_user_ids,
    get_qualified_channel_name,
    get_short_channel_name,
)
from zerver.lib.types import UserGroupMembersData
from zerver.lib.user_groups import (
    convert_to_user_group_members_dict,
    get_group_setting_value_for_api,
    get_group_setting_value_for_audit_log_data,
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
from zerver.models.realm_audit_logs import AuditLogEventType
from zerver.models.users import active_user_ids
from zerver.tornado.django_api import send_event_on_commit


@transaction.atomic(durable=True)
def check_add_channel_folder(
    realm: Realm, name: str, description: str, *, acting_user: UserProfile
) -> ChannelFolder:
    rendered_description = render_channel_folder_description(
        description, realm, acting_user=acting_user
    )
    # The creator is the first administrator of the folder.
    can_administer_group = UserGroup.objects.create(realm=realm)
    UserGroupMembership.objects.create(user_profile=acting_user, user_group=can_administer_group)
    channel_folder = ChannelFolder.objects.create(
        realm=realm,
        name=name,
        description=description,
        rendered_description=rendered_description,
        creator_id=acting_user.id,
        can_administer_group=can_administer_group,
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

    event = ChannelFolderAddEvent(
        channel_folder=ChannelFolderForChannelFolderAddEvent(
            **asdict(get_channel_folders_data([channel_folder])[0])
        ),
    )
    send_event_on_commit(realm, event, active_user_ids(realm.id))

    return channel_folder


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

    event = ChannelFolderReorderEvent(order=order)
    send_event_on_commit(realm, event, active_user_ids(realm.id))


def do_send_channel_folder_update_event(
    channel_folder: ChannelFolder, data: ChannelFolderDataForUpdate
) -> None:
    realm = channel_folder.realm
    event = ChannelFolderUpdateEvent(channel_folder_id=channel_folder.id, data=data)
    send_event_on_commit(realm, event, active_user_ids(realm.id))


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

    do_send_channel_folder_update_event(
        channel_folder,
        ChannelFolderDataForUpdate.model_validate(
            {setting_name: convert_to_user_group_members_dict(new_setting_api_value)}
        ),
    )
