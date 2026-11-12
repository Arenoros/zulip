from typing import Any

from django.core.management.base import CommandParser
from typing_extensions import override

from zerver.actions.realm_settings import do_set_realm_property
from zerver.actions.user_settings import set_avatar_to_default
from zerver.lib.management import ZulipBaseCommand
from zerver.models import Realm, UserProfile


class Command(ZulipBaseCommand):
    help = """Switch an organization to profile pictures with initials.

Makes initials the default profile picture for new users, and replaces
the Jdenticon of every existing user with their initials. Uploaded
pictures and Gravatars are left alone."""

    @override
    def add_arguments(self, parser: CommandParser) -> None:
        self.add_realm_args(parser, required=True)

    @override
    def handle(self, *args: Any, **options: Any) -> None:
        realm = self.get_realm(options)
        assert realm is not None

        do_set_realm_property(
            realm, "default_avatar_source", Realm.AVATAR_FROM_INITIALS, acting_user=None
        )
        users = UserProfile.objects.filter(
            realm=realm, avatar_source=UserProfile.AVATAR_FROM_JDENTICON
        )
        for user_profile in users:
            set_avatar_to_default(user_profile, acting_user=None)
        print(f"Replaced the profile pictures of {len(users)} users in {realm.string_id}.")
