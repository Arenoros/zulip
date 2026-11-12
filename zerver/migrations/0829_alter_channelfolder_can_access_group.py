import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0828_set_default_channelfolder_can_access_group"),
    ]

    operations = [
        migrations.AlterField(
            model_name="channelfolder",
            name="can_access_group",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT,
                related_name="+",
                to="zerver.usergroup",
            ),
        ),
    ]
