import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0834_stream_is_meeting_chat"),
    ]

    operations = [
        migrations.CreateModel(
            name="CalendarRoom",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("name", models.CharField(max_length=60)),
                ("capacity", models.PositiveIntegerField(null=True)),
                ("location", models.TextField(default="")),
                ("email", models.TextField(default="")),
                ("is_archived", models.BooleanField(default=False)),
                (
                    "realm",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to="zerver.realm"
                    ),
                ),
            ],
            options={
                "unique_together": {("realm", "name")},
            },
        ),
        migrations.CreateModel(
            name="CalendarEventRoom",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                (
                    "event",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to="zerver.calendarevent"
                    ),
                ),
                (
                    "room",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to="zerver.calendarroom"
                    ),
                ),
            ],
            options={
                "unique_together": {("event", "room")},
            },
        ),
    ]
