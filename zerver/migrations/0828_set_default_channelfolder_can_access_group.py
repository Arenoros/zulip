from django.db import migrations
from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.migrations.state import StateApps
from django.db.models import OuterRef


def set_default_value_for_channel_folder_can_access_group(
    apps: StateApps, schema_editor: BaseDatabaseSchemaEditor
) -> None:
    ChannelFolder = apps.get_model("zerver", "ChannelFolder")
    NamedUserGroup = apps.get_model("zerver", "NamedUserGroup")

    # Until now, all channel folders were visible to everyone.
    ChannelFolder.objects.filter(can_access_group=None).update(
        can_access_group=NamedUserGroup.objects.filter(
            name="role:everyone",
            realm_for_sharding=OuterRef("realm_id"),
            is_system_group=True,
        ).values("pk")
    )


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0827_channelfolder_can_access_group"),
    ]

    operations = [
        migrations.RunPython(
            set_default_value_for_channel_folder_can_access_group,
            elidable=True,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
