from django.db import migrations
from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.migrations.state import StateApps
from django.db.models import F, OuterRef, Subquery, Value
from django.db.models.functions import Concat


def qualify_names_of_channels_in_folders(
    apps: StateApps, schema_editor: BaseDatabaseSchemaEditor
) -> None:
    ChannelFolder = apps.get_model("zerver", "ChannelFolder")
    Stream = apps.get_model("zerver", "Stream")

    # This fails, on the constraint for unique names of channels in a
    # realm, if a channel already has the name another channel gets.
    Stream.objects.exclude(folder=None).update(
        name=Concat(
            Subquery(ChannelFolder.objects.filter(id=OuterRef("folder_id")).values("name")),
            Value("/"),
            F("name"),
        )
    )


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0825_alter_stream_name"),
    ]

    operations = [
        migrations.RunPython(
            qualify_names_of_channels_in_folders,
            elidable=True,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
