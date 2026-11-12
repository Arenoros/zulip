from dataclasses import asdict
from typing import Annotated

from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.utils.translation import gettext as _
from pydantic import Json, StringConstraints

from zerver.actions.channel_folders import (
    check_add_channel_folder,
    do_archive_channel_folder,
    do_change_channel_folder_description,
    do_change_channel_folder_group_based_setting,
    do_change_channel_folder_name,
    do_unarchive_channel_folder,
    try_reorder_realm_channel_folders,
)
from zerver.decorator import require_non_guest_user, require_realm_admin
from zerver.lib.channel_folders import (
    access_channel_folder_for_administration,
    check_channel_folder_in_use,
    check_channel_folder_name,
    check_channel_names_available_for_folder_name,
    get_channel_folders_in_realm,
)
from zerver.lib.exceptions import JsonableError
from zerver.lib.response import json_success
from zerver.lib.typed_endpoint import PathOnly, typed_endpoint
from zerver.lib.user_groups import (
    GroupSettingChangeRequest,
    access_user_group_api_value_for_setting,
    get_group_setting_value_for_api,
    get_system_user_group_by_name,
    parse_group_setting_value,
    validate_group_setting_value_change,
)
from zerver.models.channel_folders import ChannelFolder
from zerver.models.groups import SystemGroups
from zerver.models.users import UserProfile


@require_non_guest_user
@typed_endpoint
def create_channel_folder(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    description: Annotated[str, StringConstraints(max_length=ChannelFolder.MAX_DESCRIPTION_LENGTH)],
    name: Annotated[str, StringConstraints(max_length=ChannelFolder.MAX_NAME_LENGTH)],
) -> HttpResponse:
    realm = user_profile.realm
    check_channel_folder_name(name, realm)
    channel_folder = check_add_channel_folder(realm, name, description, acting_user=user_profile)

    return json_success(request, data={"channel_folder_id": channel_folder.id})


@typed_endpoint
def get_channel_folders(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    include_archived: Json[bool] = False,
) -> HttpResponse:
    channel_folders = get_channel_folders_in_realm(user_profile.realm, include_archived)
    return json_success(
        request,
        data={"channel_folders": [asdict(folder) for folder in channel_folders]},
    )


@require_realm_admin
@typed_endpoint
def reorder_realm_channel_folders(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    order: Json[list[int]],
) -> HttpResponse:
    try_reorder_realm_channel_folders(user_profile.realm, order)
    return json_success(request)


@typed_endpoint
def update_channel_folder(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    can_administer_group: Json[GroupSettingChangeRequest] | None = None,
    channel_folder_id: PathOnly[int],
    description: Annotated[
        str | None, StringConstraints(max_length=ChannelFolder.MAX_DESCRIPTION_LENGTH)
    ] = None,
    is_archived: Json[bool] | None = None,
    name: Annotated[str | None, StringConstraints(max_length=ChannelFolder.MAX_NAME_LENGTH)] = None,
) -> HttpResponse:
    channel_folder = access_channel_folder_for_administration(channel_folder_id, user_profile)

    if name is not None and channel_folder.name != name:
        check_channel_folder_name(name, user_profile.realm)
        check_channel_names_available_for_folder_name(channel_folder, name)
        do_change_channel_folder_name(channel_folder, name, acting_user=user_profile)

    if description is not None and channel_folder.description != description:
        do_change_channel_folder_description(channel_folder, description, acting_user=user_profile)

    if is_archived is not None and channel_folder.is_archived != is_archived:
        if is_archived:
            if check_channel_folder_in_use(channel_folder):
                raise JsonableError(
                    _("You need to remove all the channels from this folder to archive it.")
                )

            do_archive_channel_folder(channel_folder, acting_user=user_profile)
        else:
            do_unarchive_channel_folder(channel_folder, acting_user=user_profile)

    request_settings_dict = locals()
    for (
        setting_name,
        permission_configuration,
    ) in ChannelFolder.channel_folder_permission_group_settings.items():
        setting_value = request_settings_dict[setting_name]
        if setting_value is None:
            continue

        nobody_group = get_system_user_group_by_name(SystemGroups.NOBODY, user_profile.realm_id)
        new_setting_value = parse_group_setting_value(setting_value.new, nobody_group)
        expected_current_setting_value = None
        if setting_value.old is not None:
            expected_current_setting_value = parse_group_setting_value(
                setting_value.old, nobody_group
            )

        current_setting_api_value = get_group_setting_value_for_api(
            getattr(channel_folder, setting_name)
        )
        if validate_group_setting_value_change(
            current_setting_api_value, new_setting_value, expected_current_setting_value
        ):
            with transaction.atomic(durable=True):
                user_group_api_value_for_setting = access_user_group_api_value_for_setting(
                    new_setting_value,
                    user_profile.realm,
                    setting_name=setting_name,
                    permission_configuration=permission_configuration,
                )
                do_change_channel_folder_group_based_setting(
                    channel_folder,
                    setting_name,
                    user_group_api_value_for_setting,
                    acting_user=user_profile,
                )

    return json_success(request)
