# These are tests for Zulip's database migrations.  System documented at:
#   https://zulip.readthedocs.io/en/latest/subsystems/schema-migrations.html
#
# You can also read
#   https://www.caktusgroup.com/blog/2016/02/02/writing-unit-tests-django-migrations/
# to get a tutorial on the framework that inspired this feature.
from django.db.migrations.state import StateApps
from typing_extensions import override

from zerver.lib.test_classes import MigrationsTestCase

# Important note: These tests are very expensive, and details of
# Django's database transaction model mean it does not super work to
# have a lot of migrations tested in this file at once; so we usually
# delete the old migration tests when adding a new one, so this file
# always has a single migration test in it as an example.
#
# The error you get with multiple similar tests doing migrations on
# the same table is this (table name may vary):
#
#   django.db.utils.OperationalError: cannot ALTER TABLE
#   "zerver_subscription" because it has pending trigger events


class ConversationsWebChannelDefaultView(MigrationsTestCase):
    migrate_from = "0831_usersetting_web_direct_message_bubbles"
    migrate_to = "0832_conversations_web_channel_default_view"

    @override
    def setUpBeforeMigration(self, apps: StateApps) -> None:
        UserProfile = apps.get_model("zerver", "UserProfile")
        RealmUserDefault = apps.get_model("zerver", "RealmUserDefault")

        # A user who had chosen the channel feed, and one with the
        # previous default.
        UserProfile.objects.filter(delivery_email="hamlet@zulip.com").update(
            web_channel_default_view=2
        )
        UserProfile.objects.filter(delivery_email="cordelia@zulip.com").update(
            web_channel_default_view=1
        )
        RealmUserDefault.objects.update(web_channel_default_view=3)

    def test_conversations_become_the_default_view(self) -> None:
        UserProfile = self.apps.get_model("zerver", "UserProfile")
        RealmUserDefault = self.apps.get_model("zerver", "RealmUserDefault")

        self.assertEqual(
            set(UserProfile.objects.values_list("web_channel_default_view", flat=True)), {5}
        )
        self.assertEqual(
            set(RealmUserDefault.objects.values_list("web_channel_default_view", flat=True)),
            {5},
        )
