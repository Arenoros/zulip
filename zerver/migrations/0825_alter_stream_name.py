from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0824_alter_channelfolder_can_administer_group"),
    ]

    operations = [
        migrations.AlterField(
            model_name="stream",
            name="name",
            field=models.CharField(db_index=True, max_length=121),
        ),
    ]
