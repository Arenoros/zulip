import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0826_qualify_names_of_channels_in_folders"),
    ]

    operations = [
        migrations.AddField(
            model_name="channelfolder",
            name="can_access_group",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="+",
                to="zerver.usergroup",
            ),
        ),
    ]
