import django.db.models.deletion
from django.db import migrations, models
from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.migrations.state import StateApps
from django.db.models import OuterRef, Subquery


def set_ring_messages(apps: StateApps, schema_editor: BaseDatabaseSchemaEditor) -> None:
    LiveKitCall = apps.get_model("zerver", "LiveKitCall")
    LiveKitCallRing = apps.get_model("zerver", "LiveKitCallRing")
    LiveKitCallRing.objects.update(
        message_id=Subquery(
            LiveKitCall.objects.filter(id=OuterRef("call_id")).values("message_id")[:1]
        )
    )


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0818_livekit_call_rings"),
    ]

    operations = [
        migrations.AddField(
            model_name="livekitcallring",
            name="message",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="zerver.message",
            ),
        ),
        migrations.RunPython(
            set_ring_messages, reverse_code=migrations.RunPython.noop, elidable=True
        ),
        migrations.AlterField(
            model_name="livekitcallring",
            name="message",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="+",
                to="zerver.message",
            ),
        ),
    ]
