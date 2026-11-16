from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0833_calendar"),
    ]

    operations = [
        migrations.AddField(
            model_name="stream",
            name="is_meeting_chat",
            field=models.BooleanField(default=False, db_default=False),
        ),
    ]
