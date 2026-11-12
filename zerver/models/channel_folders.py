from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils.timezone import now as timezone_now

from zerver.lib.types import GroupPermissionSetting
from zerver.models.groups import SystemGroups, UserGroup
from zerver.models.realms import Realm
from zerver.models.users import UserProfile


class ChannelFolder(models.Model):
    MAX_NAME_LENGTH = 60
    MAX_DESCRIPTION_LENGTH = 1024

    realm = models.ForeignKey(Realm, on_delete=models.CASCADE)
    name = models.CharField(max_length=MAX_NAME_LENGTH)
    description = models.CharField(max_length=MAX_DESCRIPTION_LENGTH, default="")
    rendered_description = models.TextField(default="")
    order = models.IntegerField(default=0)

    date_created = models.DateTimeField(default=timezone_now)
    creator = models.ForeignKey(UserProfile, null=True, on_delete=models.SET_NULL)
    is_archived = models.BooleanField(default=False)

    # Who can change the folder and its administrators, in addition
    # to the administrators of the organization.
    can_administer_group = models.ForeignKey(UserGroup, on_delete=models.RESTRICT, related_name="+")

    channel_folder_permission_group_settings = {
        "can_administer_group": GroupPermissionSetting(
            allow_nobody_group=True,
            allow_everyone_group=False,
            default_group_name=SystemGroups.ADMINISTRATORS,
        ),
    }

    class Meta:
        constraints = [
            models.UniqueConstraint(
                Lower("name"),
                "realm",
                condition=Q(is_archived=False),
                name="unique_realm_folder_name_when_not_archived",
            ),
        ]
