from django.db import migrations, models
from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.migrations.state import StateApps

WEB_CHANNEL_DEFAULT_VIEW_CONVERSATIONS = 5


def set_conversations_as_web_channel_default_view(
    apps: StateApps, schema_editor: BaseDatabaseSchemaEditor
) -> None:
    UserProfile = apps.get_model("zerver", "UserProfile")
    RealmUserDefault = apps.get_model("zerver", "RealmUserDefault")

    # Conversations become the default view of channels for everyone,
    # including users who had chosen another view, since a choice
    # cannot be told apart from the previous default.
    UserProfile.objects.update(web_channel_default_view=WEB_CHANNEL_DEFAULT_VIEW_CONVERSATIONS)
    RealmUserDefault.objects.update(
        web_channel_default_view=WEB_CHANNEL_DEFAULT_VIEW_CONVERSATIONS
    )


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0831_usersetting_web_direct_message_bubbles"),
    ]

    operations = [
        migrations.AlterField(
            model_name="realmuserdefault",
            name="web_channel_default_view",
            field=models.SmallIntegerField(db_default=5, default=5),
        ),
        migrations.AlterField(
            model_name="userprofile",
            name="web_channel_default_view",
            field=models.SmallIntegerField(db_default=5, default=5),
        ),
        migrations.RunPython(
            set_conversations_as_web_channel_default_view,
            elidable=True,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
