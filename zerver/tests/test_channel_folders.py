from typing import TYPE_CHECKING, Any

import orjson
from typing_extensions import override

from zerver.actions.channel_folders import (
    check_add_channel_folder,
    do_archive_channel_folder,
    do_change_channel_folder_group_based_setting,
    do_change_channel_folder_name,
    try_reorder_realm_channel_folders,
)
from zerver.actions.default_streams import do_add_default_stream
from zerver.actions.message_send import check_send_stream_message
from zerver.actions.streams import (
    bulk_add_subscriptions,
    do_change_stream_description,
    do_change_stream_folder,
    do_change_stream_group_based_setting,
    do_deactivate_stream,
)
from zerver.actions.user_groups import check_add_user_group
from zerver.lib.streams import create_stream_if_needed
from zerver.lib.subscription_info import gather_subscriptions_helper
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.types import UserGroupMembersData
from zerver.models import ChannelFolder, Message, NamedUserGroup, RealmAuditLog, Stream, UserProfile
from zerver.models.clients import get_client
from zerver.models.groups import SystemGroups
from zerver.models.realm_audit_logs import AuditLogEventType
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse as TestHttpResponse


class ChannelFoldersTestCase(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        zulip_realm = get_realm("zulip")
        iago = self.example_user("iago")
        desdemona = self.example_user("desdemona")
        lear_user = self.lear_user("cordelia")

        check_add_channel_folder(
            zulip_realm,
            "Frontend",
            "Channels for frontend discussions",
            acting_user=iago,
        )
        check_add_channel_folder(
            zulip_realm, "Backend", "Channels for **backend** discussions", acting_user=iago
        )
        check_add_channel_folder(
            zulip_realm, "Marketing", "Channels for marketing discussions", acting_user=desdemona
        )
        check_add_channel_folder(
            lear_user.realm, "Devops", "Channels for devops discussions", acting_user=lear_user
        )


class ChannelFolderCreationTest(ZulipTestCase):
    def test_creating_channel_folder(self) -> None:
        self.login("polonius")
        realm = get_realm("zulip")

        params = {"name": "Frontend", "description": ""}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(result, "Not allowed for guest users")

        self.login("iago")
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.filter(realm=realm).last()
        assert channel_folder is not None
        self.assertEqual(channel_folder.name, "Frontend")
        self.assertEqual(channel_folder.description, "")
        self.assertEqual(channel_folder.id, channel_folder.order)
        response = orjson.loads(result.content)
        self.assertEqual(response["channel_folder_id"], channel_folder.id)

        # A member can create a folder, and becomes its administrator.
        shiva = self.example_user("shiva")
        self.login_user(shiva)
        result = self.client_post(
            "/json/channel_folders/create", {"name": "Backend", "description": ""}
        )
        channel_folder_id = self.assert_json_success(result)["channel_folder_id"]
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertEqual(channel_folder.creator, shiva)
        self.assertFalse(hasattr(channel_folder.can_administer_group, "named_user_group"))
        self.assertEqual(
            list(channel_folder.can_administer_group.direct_members.all()),
            [shiva],
        )
        self.assertEqual(list(channel_folder.can_administer_group.direct_subgroups.all()), [])

    def test_creating_channel_folder_with_duplicate_name(self) -> None:
        self.login("iago")
        realm = get_realm("zulip")

        params = {"name": "Frontend", "description": ""}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_success(result)
        self.assertTrue(ChannelFolder.objects.filter(realm=realm, name="Frontend").exists())

        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(result, "Channel folder name already in use")

        # Archived folder names can be reused.
        folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        do_archive_channel_folder(folder, acting_user=self.example_user("iago"))

        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_success(result)
        self.assertTrue(ChannelFolder.objects.filter(realm=realm, name="Frontend").exists())

        # Folder names should be unique case-insensitively.
        params["name"] = "frontEND"
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(result, "Channel folder name already in use")

    def test_rendered_description_for_channel_folder(self) -> None:
        self.login("iago")
        realm = get_realm("zulip")

        params = {"name": "Frontend", "description": "Channels for frontend discussions"}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(realm=realm, name="Frontend")
        self.assertEqual(channel_folder.description, "Channels for frontend discussions")
        self.assertEqual(
            channel_folder.rendered_description, "<p>Channels for frontend discussions</p>"
        )

        params = {"name": "Backend", "description": "Channels for **backend** discussions"}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(realm=realm, name="Backend")
        self.assertEqual(channel_folder.description, "Channels for **backend** discussions")
        self.assertEqual(
            channel_folder.rendered_description,
            "<p>Channels for <strong>backend</strong> discussions</p>",
        )

    def test_invalid_params_for_channel_folder(self) -> None:
        self.login("iago")

        params = {"name": "", "description": "Channels for frontend discussions"}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(result, "Channel folder name can't be empty.")

        invalid_name = "abc\000"
        params = {"name": invalid_name, "description": "Channels for frontend discussions"}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(result, "Invalid character in channel folder name, at position 4.")

        params = {"name": "front/end", "description": "Channels for frontend discussions"}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(result, "Channel folder name can't contain '/'.")

        long_name = "a" * (ChannelFolder.MAX_NAME_LENGTH + 1)
        params = {"name": long_name, "description": "Channels for frontend discussions"}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(
            result, f"name is too long (limit: {ChannelFolder.MAX_NAME_LENGTH} characters)"
        )

        long_description = "a" * (ChannelFolder.MAX_DESCRIPTION_LENGTH + 1)
        params = {"name": "Frontend", "description": long_description}
        result = self.client_post("/json/channel_folders/create", params)
        self.assert_json_error(
            result,
            f"description is too long (limit: {ChannelFolder.MAX_DESCRIPTION_LENGTH} characters)",
        )


class GetChannelFoldersTest(ChannelFoldersTestCase):
    def test_get_channel_folders(self) -> None:
        iago = self.example_user("iago")
        desdemona = self.example_user("desdemona")
        zulip_realm = iago.realm
        frontend_folder = ChannelFolder.objects.get(name="Frontend", realm=zulip_realm)
        backend_folder = ChannelFolder.objects.get(name="Backend", realm=zulip_realm)
        marketing_folder = ChannelFolder.objects.get(name="Marketing", realm=zulip_realm)

        def check_channel_folders_in_zulip_realm(
            channel_folders: list[dict[str, Any]], marketing_folder_included: bool = True
        ) -> None:
            if marketing_folder_included:
                self.assert_length(channel_folders, 3)
            else:
                self.assert_length(channel_folders, 2)

            self.assertEqual(channel_folders[0]["id"], frontend_folder.id)
            self.assertEqual(channel_folders[0]["name"], "Frontend")
            self.assertEqual(channel_folders[0]["description"], "Channels for frontend discussions")
            self.assertEqual(
                channel_folders[0]["rendered_description"],
                "<p>Channels for frontend discussions</p>",
            )
            self.assertEqual(channel_folders[0]["is_archived"], frontend_folder.is_archived)
            self.assertEqual(channel_folders[0]["creator_id"], iago.id)
            self.assertEqual(
                channel_folders[0]["can_administer_group"],
                {"direct_members": [iago.id], "direct_subgroups": []},
            )

            self.assertEqual(channel_folders[1]["id"], backend_folder.id)
            self.assertEqual(channel_folders[1]["name"], "Backend")
            self.assertEqual(
                channel_folders[1]["description"], "Channels for **backend** discussions"
            )
            self.assertEqual(
                channel_folders[1]["rendered_description"],
                "<p>Channels for <strong>backend</strong> discussions</p>",
            )
            self.assertEqual(channel_folders[1]["is_archived"], backend_folder.is_archived)
            self.assertEqual(channel_folders[1]["creator_id"], iago.id)

            if marketing_folder_included:
                self.assertEqual(channel_folders[2]["id"], marketing_folder.id)
                self.assertEqual(channel_folders[2]["name"], "Marketing")
                self.assertEqual(
                    channel_folders[2]["description"], "Channels for marketing discussions"
                )
                self.assertEqual(
                    channel_folders[2]["rendered_description"],
                    "<p>Channels for marketing discussions</p>",
                )
                self.assertEqual(channel_folders[2]["is_archived"], marketing_folder.is_archived)
                self.assertEqual(channel_folders[2]["creator_id"], desdemona.id)

        self.login("iago")
        result = self.client_get("/json/channel_folders")
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        check_channel_folders_in_zulip_realm(channel_folders_data)

        # Check member user can also see all channel folders.
        self.login("hamlet")
        result = self.client_get("/json/channel_folders")
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        check_channel_folders_in_zulip_realm(channel_folders_data)

        # Check guest can also see all channel folders.
        self.login("polonius")
        result = self.client_get("/json/channel_folders")
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        check_channel_folders_in_zulip_realm(channel_folders_data)

        marketing_folder.is_archived = True
        marketing_folder.save()

        result = self.client_get("/json/channel_folders")
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        check_channel_folders_in_zulip_realm(channel_folders_data, False)

        result = self.client_get(
            "/json/channel_folders", {"include_archived": orjson.dumps(True).decode()}
        )
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        check_channel_folders_in_zulip_realm(channel_folders_data)

    def test_get_channel_folders_according_to_order(self) -> None:
        iago = self.example_user("iago")
        realm = iago.realm
        self.login_user(iago)

        result = self.client_get("/json/channel_folders")
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        channel_folders_names = [item["name"] for item in channel_folders_data]
        self.assertEqual(channel_folders_names, ["Frontend", "Backend", "Marketing"])

        try_reorder_realm_channel_folders(
            realm, list(reversed([item["id"] for item in channel_folders_data]))
        )
        result = self.client_get("/json/channel_folders")
        channel_folders_data = orjson.loads(result.content)["channel_folders"]
        channel_folders_names = [item["name"] for item in channel_folders_data]
        self.assertEqual(channel_folders_names, ["Marketing", "Backend", "Frontend"])


class UpdateChannelFoldersTest(ChannelFoldersTestCase):
    def test_updating_channel_folder_name(self) -> None:
        realm = get_realm("zulip")
        channel_folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        channel_folder_id = channel_folder.id

        self.login("hamlet")

        params = {"name": "Web frontend"}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Insufficient permission")

        self.login("iago")

        # Test invalid channel folder ID.
        result = self.client_patch("/json/channel_folders/999", params)
        self.assert_json_error(result, "Invalid channel folder ID")

        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertEqual(channel_folder.name, "Web frontend")

        params = {"name": ""}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Channel folder name can't be empty.")

        params = {"name": "Backend"}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Channel folder name already in use")

        # Folder names should be unique case-insensitively.
        params = {"name": "backEND"}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Channel folder name already in use")

        invalid_name = "abc\000"
        params = {"name": invalid_name}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Invalid character in channel folder name, at position 4.")

        params = {"name": "front/end"}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Channel folder name can't contain '/'.")

        long_name = "a" * (ChannelFolder.MAX_NAME_LENGTH + 1)
        params = {"name": long_name}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(
            result, f"name is too long (limit: {ChannelFolder.MAX_NAME_LENGTH} characters)"
        )

    def test_updating_channel_folder_description(self) -> None:
        channel_folder = ChannelFolder.objects.get(name="Frontend", realm=get_realm("zulip"))
        channel_folder_id = channel_folder.id

        self.login("hamlet")

        params = {"description": "Channels for **frontend** discussions"}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Insufficient permission")

        self.login("iago")

        # Test invalid channel folder ID.
        result = self.client_patch("/json/channel_folders/999", params)
        self.assert_json_error(result, "Invalid channel folder ID")

        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertEqual(channel_folder.description, "Channels for **frontend** discussions")
        self.assertEqual(
            channel_folder.rendered_description,
            "<p>Channels for <strong>frontend</strong> discussions</p>",
        )

        # Channel folder descriptions can be empty.
        params = {"description": ""}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertEqual(channel_folder.description, "")
        self.assertEqual(channel_folder.rendered_description, "")

        params = {"description": "a" * (ChannelFolder.MAX_DESCRIPTION_LENGTH + 1)}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(
            result,
            f"description is too long (limit: {ChannelFolder.MAX_DESCRIPTION_LENGTH} characters)",
        )

    def test_archiving_and_unarchiving_channel_folder(self) -> None:
        desdemona = self.example_user("desdemona")
        realm = get_realm("zulip")
        channel_folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        channel_folder_id = channel_folder.id

        self.login("hamlet")

        params = {"is_archived": orjson.dumps(True).decode()}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(result, "Insufficient permission")

        self.login("iago")

        # Test invalid channel folder ID.
        result = self.client_patch("/json/channel_folders/999", params)
        self.assert_json_error(result, "Invalid channel folder ID")

        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertTrue(channel_folder.is_archived)

        params = {"is_archived": orjson.dumps(False).decode()}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertFalse(channel_folder.is_archived)

        # Folder containing channels cannot be archived.
        stream = get_stream("Verona", realm)
        do_change_stream_folder(stream, channel_folder, acting_user=desdemona)
        params = {"is_archived": orjson.dumps(True).decode()}
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(
            result, "You need to remove all the channels from this folder to archive it."
        )

        do_deactivate_stream(stream, acting_user=desdemona)
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_error(
            result, "You need to remove all the channels from this folder to archive it."
        )

        do_change_stream_folder(stream, None, acting_user=desdemona)
        result = self.client_patch(f"/json/channel_folders/{channel_folder_id}", params)
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertTrue(channel_folder.is_archived)


class ChannelFolderAdministratorsTest(ChannelFoldersTestCase):
    def test_folder_administrator_can_update_folder(self) -> None:
        realm = get_realm("zulip")
        hamlet = self.example_user("hamlet")
        self.login_user(hamlet)
        result = self.client_post(
            "/json/channel_folders/create", {"name": "Design", "description": ""}
        )
        channel_folder_id = self.assert_json_success(result)["channel_folder_id"]

        # The creator administers the folder without being an
        # organization administrator.
        result = self.client_patch(
            f"/json/channel_folders/{channel_folder_id}",
            {"name": "Product design", "description": "Design channels"},
        )
        self.assert_json_success(result)
        channel_folder = ChannelFolder.objects.get(id=channel_folder_id)
        self.assertEqual(channel_folder.name, "Product design")
        self.assertEqual(channel_folder.description, "Design channels")

        result = self.client_patch(
            f"/json/channel_folders/{channel_folder_id}",
            {"is_archived": orjson.dumps(True).decode()},
        )
        self.assert_json_success(result)
        channel_folder.refresh_from_db()
        self.assertTrue(channel_folder.is_archived)

        # Other members cannot change it, including its administrators.
        cordelia = self.example_user("cordelia")
        self.login_user(cordelia)
        result = self.client_patch(
            f"/json/channel_folders/{channel_folder_id}", {"name": "Cordelia's folder"}
        )
        self.assert_json_error(result, "Insufficient permission")
        result = self.client_patch(
            f"/json/channel_folders/{channel_folder_id}",
            {
                "can_administer_group": orjson.dumps(
                    {"new": {"direct_members": [cordelia.id], "direct_subgroups": []}}
                ).decode()
            },
        )
        self.assert_json_error(result, "Insufficient permission")
        self.assertEqual(
            list(channel_folder.can_administer_group.direct_members.all()),
            [hamlet],
        )

        # The creator still cannot change folders of other users, or
        # the order of the folders.
        self.login_user(hamlet)
        frontend_folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        result = self.client_patch(
            f"/json/channel_folders/{frontend_folder.id}", {"name": "Hamlet's folder"}
        )
        self.assert_json_error(result, "Insufficient permission")
        result = self.client_patch(
            "/json/channel_folders",
            {"order": orjson.dumps([channel_folder_id]).decode()},
        )
        self.assert_json_error(result, "Must be an organization administrator")

    def test_changing_folder_administrators(self) -> None:
        realm = get_realm("zulip")
        iago = self.example_user("iago")
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        channel_folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        url = f"/json/channel_folders/{channel_folder.id}"
        leadership_group = check_add_user_group(realm, "leadership", [othello], acting_user=iago)
        moderators_group = NamedUserGroup.objects.get(
            name=SystemGroups.MODERATORS, realm_for_sharding=realm, is_system_group=True
        )

        def set_administrators(new: object, old: object = None) -> "TestHttpResponse":
            value = {"new": new} if old is None else {"new": new, "old": old}
            return self.client_patch(url, {"can_administer_group": orjson.dumps(value).decode()})

        # An organization administrator can appoint administrators of
        # a folder they did not create.
        self.login("desdemona")
        with self.capture_send_event_calls(expected_num_events=1) as events:
            result = set_administrators(
                {"direct_members": [hamlet.id], "direct_subgroups": [leadership_group.id]}
            )
        self.assert_json_success(result)
        self.assertEqual(
            events[0]["event"],
            dict(
                type="channel_folder",
                op="update",
                channel_folder_id=channel_folder.id,
                data=dict(
                    can_administer_group=dict(
                        direct_members=[hamlet.id], direct_subgroups=[leadership_group.id]
                    )
                ),
            ),
        )
        audit_log = RealmAuditLog.objects.filter(
            event_type=AuditLogEventType.CHANNEL_FOLDER_GROUP_BASED_SETTING_CHANGED
        ).last()
        assert audit_log is not None
        self.assertEqual(audit_log.modified_channel_folder, channel_folder)
        self.assertEqual(
            audit_log.extra_data,
            {
                RealmAuditLog.OLD_VALUE: {"direct_members": [iago.id], "direct_subgroups": []},
                RealmAuditLog.NEW_VALUE: {
                    "direct_members": [hamlet.id],
                    "direct_subgroups": [leadership_group.id],
                },
                "property": "can_administer_group",
            },
        )

        # Members of a group that administers the folder administer it,
        # and the previous administrator does not anymore.
        self.login_user(othello)
        result = self.client_patch(url, {"name": "Web frontend"})
        self.assert_json_success(result)
        self.login_user(cordelia)
        result = self.client_patch(url, {"name": "Cordelia's folder"})
        self.assert_json_error(result, "Insufficient permission")

        # A folder administrator can appoint other administrators.
        self.login_user(hamlet)
        result = set_administrators(moderators_group.id)
        self.assert_json_success(result)
        channel_folder.refresh_from_db()
        self.assertEqual(channel_folder.can_administer_group_id, moderators_group.id)
        result = self.client_patch(url, {"name": "Hamlet's folder"})
        self.assert_json_error(result, "Insufficient permission")

        # Requests that do not change the value send no events.
        self.login("iago")
        with self.capture_send_event_calls(expected_num_events=0):
            result = set_administrators(moderators_group.id)
        self.assert_json_success(result)

        result = set_administrators(leadership_group.id, old=leadership_group.id)
        self.assert_json_error(result, "'old' value does not match the expected value.")

        everyone_group = NamedUserGroup.objects.get(
            name=SystemGroups.EVERYONE, realm_for_sharding=realm, is_system_group=True
        )
        result = set_administrators(everyone_group.id)
        self.assert_json_error(
            result, "'can_administer_group' setting cannot be set to 'role:everyone' group."
        )
        result = set_administrators(999999)
        self.assert_json_error(result, "Invalid user group")
        result = set_administrators({"direct_members": [hamlet.id], "direct_subgroups": [999999]})
        self.assert_json_error(result, "Invalid user group ID: 999999")

        # Guests cannot administer folders, even when listed.
        polonius = self.example_user("polonius")
        result = set_administrators({"direct_members": [polonius.id], "direct_subgroups": []})
        self.assert_json_success(result)
        self.login_user(polonius)
        result = self.client_patch(url, {"name": "Polonius's folder"})
        self.assert_json_error(result, "Insufficient permission")

        # An empty set of administrators leaves the folder to the
        # administrators of the organization.
        self.login("iago")
        result = set_administrators({"direct_members": [], "direct_subgroups": []})
        self.assert_json_success(result)
        channel_folder.refresh_from_db()
        nobody_group = NamedUserGroup.objects.get(
            name=SystemGroups.NOBODY, realm_for_sharding=realm, is_system_group=True
        )
        self.assertEqual(channel_folder.can_administer_group_id, nobody_group.id)
        result = self.client_patch(url, {"name": "Frontend"})
        self.assert_json_success(result)

    def test_user_group_administering_folder_cannot_be_deactivated(self) -> None:
        realm = get_realm("zulip")
        iago = self.example_user("iago")
        othello = self.example_user("othello")
        frontend_folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        backend_folder = ChannelFolder.objects.get(name="Backend", realm=realm)
        leadership_group = check_add_user_group(realm, "leadership", [othello], acting_user=iago)

        self.login_user(iago)
        for channel_folder, value in [
            (frontend_folder, leadership_group.id),
            (
                backend_folder,
                {"direct_members": [iago.id], "direct_subgroups": [leadership_group.id]},
            ),
        ]:
            result = self.client_patch(
                f"/json/channel_folders/{channel_folder.id}",
                {"can_administer_group": orjson.dumps({"new": value}).decode()},
            )
            self.assert_json_success(result)

        result = self.client_post(f"/json/user_groups/{leadership_group.id}/deactivate")
        self.assert_json_error(result, "Cannot deactivate user group in use.")
        self.assertEqual(
            orjson.loads(result.content)["objections"],
            [
                {
                    "type": "channel_folder",
                    "channel_folder_id": frontend_folder.id,
                    "settings": ["can_administer_group"],
                },
                {
                    "type": "channel_folder",
                    "channel_folder_id": backend_folder.id,
                    "settings": ["can_administer_group"],
                },
            ],
        )

        # Archived folders do not keep a group from being deactivated.
        do_archive_channel_folder(frontend_folder, acting_user=iago)
        do_archive_channel_folder(backend_folder, acting_user=iago)
        result = self.client_post(f"/json/user_groups/{leadership_group.id}/deactivate")
        self.assert_json_success(result)


class MoveChannelBetweenFoldersTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.realm = get_realm("zulip")
        self.hamlet = self.example_user("hamlet")
        self.cordelia = self.example_user("cordelia")
        self.othello = self.example_user("othello")
        # Hamlet and Cordelia each administer a folder, and Othello
        # administers a channel that is in no folder.
        self.design_folder = check_add_channel_folder(
            self.realm, "Design", "", acting_user=self.hamlet
        )
        self.research_folder = check_add_channel_folder(
            self.realm, "Research", "", acting_user=self.cordelia
        )
        self.channel = self.make_channel_administered_by_othello("sketches")
        self.url = f"/json/streams/{self.channel.id}"

    def make_channel_administered_by_othello(self, name: str, invite_only: bool = False) -> Stream:
        channel = self.make_stream(name, invite_only=invite_only)
        do_change_stream_group_based_setting(
            channel,
            "can_administer_channel_group",
            UserGroupMembersData(direct_members=[self.othello.id], direct_subgroups=[]),
            acting_user=self.othello,
        )
        return channel

    def move_channel(
        self, user: UserProfile, folder: ChannelFolder | None, **extra: str
    ) -> "TestHttpResponse":
        self.login_user(user)
        folder_id = None if folder is None else folder.id
        return self.client_patch(self.url, {"folder_id": orjson.dumps(folder_id).decode(), **extra})

    def assert_channel_folder(self, folder: ChannelFolder | None) -> None:
        self.channel.refresh_from_db()
        self.assertEqual(self.channel.folder, folder)

    def set_folder_administrators(self, folder: ChannelFolder, users: list[UserProfile]) -> None:
        do_change_channel_folder_group_based_setting(
            folder,
            "can_administer_group",
            UserGroupMembersData(direct_members=[user.id for user in users], direct_subgroups=[]),
            acting_user=self.example_user("iago"),
        )

    def test_moving_channel_into_folder(self) -> None:
        # Administering the folder is not enough to move a channel
        # that is in no folder into it.
        result = self.move_channel(self.hamlet, self.design_folder)
        self.assert_json_error(result, "You do not have permission to administer this channel.")

        # Administering the channel is not enough either.
        result = self.move_channel(self.othello, self.design_folder)
        self.assert_json_error(result, "Insufficient permission")
        self.assert_channel_folder(None)

        self.set_folder_administrators(self.design_folder, [self.hamlet, self.othello])
        result = self.move_channel(self.othello, self.design_folder)
        self.assert_json_success(result)
        self.assert_channel_folder(self.design_folder)

    def test_moving_channel_between_folders(self) -> None:
        do_change_stream_folder(self.channel, self.design_folder, acting_user=self.othello)

        # Moving a channel takes administering both folders, and not
        # the channel.
        for user in [self.hamlet, self.cordelia, self.othello]:
            result = self.move_channel(user, self.research_folder)
            self.assert_json_error(result, "Insufficient permission")
        self.assert_channel_folder(self.design_folder)

        self.set_folder_administrators(self.research_folder, [self.cordelia, self.hamlet])
        result = self.move_channel(self.hamlet, self.research_folder)
        self.assert_json_success(result)
        self.assert_channel_folder(self.research_folder)

        # Organization administrators administer every folder.
        result = self.move_channel(self.example_user("iago"), self.design_folder)
        self.assert_json_success(result)
        self.assert_channel_folder(self.design_folder)

    def test_moving_channel_out_of_folder(self) -> None:
        do_change_stream_folder(self.channel, self.design_folder, acting_user=self.othello)

        # Administering the channel is not enough to move it out of
        # its folder.
        result = self.move_channel(self.othello, None)
        self.assert_json_error(result, "Insufficient permission")
        result = self.move_channel(self.cordelia, None)
        self.assert_json_error(result, "Insufficient permission")
        self.assert_channel_folder(self.design_folder)

        # An administrator of the folder can move the channel out of
        # it without administering the channel.
        result = self.move_channel(self.hamlet, None)
        self.assert_json_success(result)
        self.assert_channel_folder(None)

    def test_moving_channel_with_other_changes(self) -> None:
        do_change_stream_folder(self.channel, self.design_folder, acting_user=self.othello)

        # Administering the folder of a channel allows nothing but
        # moving the channel.
        for extra in [{"description": "Changed"}, {"unknown_parameter": "value"}]:
            result = self.move_channel(self.hamlet, None, **extra)
            self.assert_json_error(result, "You do not have permission to administer this channel.")
        self.login_user(self.hamlet)
        result = self.client_patch(
            f"{self.url}?description=Changed", {"folder_id": orjson.dumps(None).decode()}
        )
        self.assert_json_error(result, "You do not have permission to administer this channel.")
        self.assert_channel_folder(self.design_folder)
        self.assertEqual(self.channel.description, "")

        # Those who administer the channel still need to administer
        # its folder to move it together with another change.
        result = self.move_channel(self.othello, None, description="Changed")
        self.assert_json_error(result, "Insufficient permission")
        self.assert_channel_folder(self.design_folder)

        self.set_folder_administrators(self.design_folder, [self.othello])
        result = self.move_channel(self.othello, None, description="Changed")
        self.assert_json_success(result)
        self.assert_channel_folder(None)
        self.assertEqual(self.channel.description, "Changed")

    def test_moving_channel_without_access_to_it(self) -> None:
        private_channel = self.make_channel_administered_by_othello("secret", invite_only=True)
        self.subscribe(self.othello, private_channel.name)
        do_change_stream_folder(private_channel, self.design_folder, acting_user=self.othello)

        # An administrator of a folder cannot move a channel that they
        # cannot see out of it.
        self.login_user(self.hamlet)
        result = self.client_patch(
            f"/json/streams/{private_channel.id}", {"folder_id": orjson.dumps(None).decode()}
        )
        self.assert_json_error(result, "Invalid channel ID")
        result = self.client_patch(
            "/json/streams/999999", {"folder_id": orjson.dumps(None).decode()}
        )
        self.assert_json_error(result, "Invalid channel ID")
        private_channel.refresh_from_db()
        self.assertEqual(private_channel.folder, self.design_folder)

        self.subscribe(self.hamlet, private_channel.name)
        result = self.client_patch(
            f"/json/streams/{private_channel.id}", {"folder_id": orjson.dumps(None).decode()}
        )
        self.assert_json_success(result)
        private_channel.refresh_from_db()
        self.assertIsNone(private_channel.folder)

    def test_keeping_channel_in_its_folder(self) -> None:
        do_change_stream_folder(self.channel, self.design_folder, acting_user=self.othello)

        # Asking for the folder the channel is already in is not a move.
        result = self.move_channel(self.othello, self.design_folder, description="Changed")
        self.assert_json_success(result)
        self.assert_channel_folder(self.design_folder)

        result = self.move_channel(self.hamlet, self.research_folder)
        self.assert_json_error(result, "Insufficient permission")
        result = self.move_channel(self.hamlet, self.design_folder)
        self.assert_json_success(result)


class ReorderChannelFolderTest(ChannelFoldersTestCase):
    def test_reorder(self) -> None:
        self.login("iago")
        realm = get_realm("zulip")
        order = list(
            ChannelFolder.objects.filter(realm=realm)
            .order_by("-order")
            .values_list("order", flat=True)
        )
        result = self.client_patch(
            "/json/channel_folders", info={"order": orjson.dumps(order).decode()}
        )
        self.assert_json_success(result)
        fields = ChannelFolder.objects.filter(realm=realm).order_by("order")
        for field in fields:
            self.assertEqual(field.id, order[field.order])

    def test_reorder_duplicates(self) -> None:
        self.login("iago")
        realm = get_realm("zulip")
        order = list(
            ChannelFolder.objects.filter(realm=realm)
            .order_by("-order")
            .values_list("order", flat=True)
        )
        frontend_folder = ChannelFolder.objects.get(name="Frontend", realm=realm)
        order.append(frontend_folder.id)
        result = self.client_patch(
            "/json/channel_folders", info={"order": orjson.dumps(order).decode()}
        )
        self.assert_json_success(result)
        fields = ChannelFolder.objects.filter(realm=realm).order_by("order")
        for field in fields:
            self.assertEqual(field.id, order[field.order])

    def test_reorder_unauthorized(self) -> None:
        self.login("hamlet")
        realm = get_realm("zulip")
        order = list(
            ChannelFolder.objects.filter(realm=realm)
            .order_by("-order")
            .values_list("order", flat=True)
        )
        result = self.client_patch(
            "/json/channel_folders", info={"order": orjson.dumps(order).decode()}
        )
        self.assert_json_error(result, "Must be an organization administrator")

    def test_reorder_invalid(self) -> None:
        self.login("iago")
        order = [100, 200, 300]
        result = self.client_patch(
            "/json/channel_folders", info={"order": orjson.dumps(order).decode()}
        )
        self.assert_json_error(result, "Invalid order mapping.")
        order = [1, 2]
        result = self.client_patch(
            "/json/channel_folders", info={"order": orjson.dumps(order).decode()}
        )
        self.assert_json_error(result, "Invalid order mapping.")


class ChannelNamesInFoldersTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.iago = self.example_user("iago")
        self.realm = self.iago.realm
        self.development_folder = check_add_channel_folder(
            self.realm, "Development", "", acting_user=self.iago
        )
        self.support_folder = check_add_channel_folder(
            self.realm, "Support", "", acting_user=self.iago
        )
        self.login_user(self.iago)

    def create_channel(self, name: str, folder: ChannelFolder | None) -> "TestHttpResponse":
        extra_post_data = {}
        if folder is not None:
            extra_post_data["folder_id"] = orjson.dumps(folder.id).decode()
        return self.create_channel_via_post(self.iago, name=name, extra_post_data=extra_post_data)

    def make_channel_in_folder(self, short_name: str, folder: ChannelFolder) -> Stream:
        channel = self.make_stream(short_name)
        do_change_stream_folder(channel, folder, acting_user=self.iago)
        return channel

    def test_creating_channels_with_same_name_in_different_folders(self) -> None:
        self.assert_json_success(self.create_channel("General", self.development_folder))
        self.assert_json_success(self.create_channel("General", self.support_folder))
        self.assert_json_success(self.create_channel("General", None))

        development_general = get_stream("Development/General", self.realm)
        support_general = get_stream("Support/General", self.realm)
        general = get_stream("General", self.realm)
        self.assertEqual(development_general.folder_id, self.development_folder.id)
        self.assertEqual(support_general.folder_id, self.support_folder.id)
        self.assertIsNone(general.folder_id)

        # Each of them is found by its name.
        for channel in [development_general, support_general, general]:
            result = self.client_get("/json/get_stream_id", {"stream": channel.name})
            self.assertEqual(self.assert_json_success(result)["stream_id"], channel.id)
            message_id = self.send_stream_message(self.iago, channel.name)
            self.assertEqual(Message.objects.get(id=message_id).recipient_id, channel.recipient_id)

        # Names are unique in a folder without regard to case.
        result = self.create_channel("general", self.support_folder)
        self.assert_json_error(result, "Channel 'Support/general' already exists", status_code=409)

    def test_names_for_creating_channel_in_folder(self) -> None:
        # The name can be given with the name of the folder.
        self.assert_json_success(self.create_channel("Support/Billing", self.support_folder))
        self.assertEqual(
            get_stream("Support/Billing", self.realm).folder_id, self.support_folder.id
        )

        result = self.create_channel("Development/Billing", self.support_folder)
        self.assert_json_error(result, "Channel name can't contain '/'.")

        result = self.create_channel("Support/", self.support_folder)
        self.assert_json_error(result, "Channel name can't be empty.")

        result = self.create_channel("a" * 61, self.support_folder)
        self.assert_json_error(result, "Channel name too long (limit: 60 characters).")

        # The limit is for the name without the name of the folder.
        self.assert_json_success(self.create_channel("a" * 60, self.support_folder))
        self.assertTrue(
            Stream.objects.filter(realm=self.realm, name="Support/" + "a" * 60).exists()
        )

    def test_creating_channels_in_folder_by_subscribing(self) -> None:
        folder_id = orjson.dumps(self.support_folder.id).decode()
        self.subscribe_via_post(self.iago, ["General", "Support/Billing"], {"folder_id": folder_id})
        for name in ["Support/General", "Support/Billing"]:
            channel = get_stream(name, self.realm)
            self.assertEqual(channel.folder_id, self.support_folder.id)
            self.assertIn(self.iago, self.users_subscribed_to_stream(name, self.realm))

        # The same request subscribes to the channels once they exist.
        hamlet = self.example_user("hamlet")
        self.subscribe_via_post(hamlet, ["General"], {"folder_id": folder_id})
        self.assertIn(hamlet, self.users_subscribed_to_stream("Support/General", self.realm))
        self.assertFalse(Stream.objects.filter(realm=self.realm, name="General").exists())

        result = self.subscribe_via_post(
            self.iago, ["Development/General"], {"folder_id": folder_id}, allow_fail=True
        )
        self.assert_json_error(result, "Channel name can't contain '/'.")

    def test_renaming_channel_in_folder(self) -> None:
        channel = self.make_channel_in_folder("General", self.support_folder)
        self.make_channel_in_folder("Taken", self.support_folder)

        result = self.client_patch(f"/json/streams/{channel.id}", {"new_name": "Billing"})
        self.assert_json_success(result)
        channel.refresh_from_db()
        self.assertEqual(channel.name, "Support/Billing")

        # The new name can be given with the name of the folder.
        result = self.client_patch(f"/json/streams/{channel.id}", {"new_name": "Support/Refunds"})
        self.assert_json_success(result)
        channel.refresh_from_db()
        self.assertEqual(channel.name, "Support/Refunds")

        result = self.client_patch(f"/json/streams/{channel.id}", {"new_name": "Refunds"})
        self.assert_json_error(result, "Channel already has that name.")

        result = self.client_patch(
            f"/json/streams/{channel.id}", {"new_name": "Development/Refunds"}
        )
        self.assert_json_error(result, "Channel name can't contain '/'.")

        result = self.client_patch(f"/json/streams/{channel.id}", {"new_name": "taken"})
        self.assert_json_error(result, "Channel 'Support/taken' already exists", status_code=409)
        channel.refresh_from_db()
        self.assertEqual(channel.name, "Support/Refunds")

    def test_moving_channel_renames_it(self) -> None:
        channel = self.make_stream("General")
        self.subscribe(self.iago, "General")
        last_message_id = self.get_last_message().id

        def move_channel(folder: ChannelFolder | None, expected_name: str) -> None:
            old_name = channel.name
            folder_id = None if folder is None else folder.id
            with self.capture_send_event_calls(expected_num_events=2) as events:
                result = self.client_patch(
                    f"/json/streams/{channel.id}", {"folder_id": orjson.dumps(folder_id).decode()}
                )
            self.assert_json_success(result)
            self.assertEqual(events[0]["event"]["property"], "folder_id")
            self.assertEqual(events[0]["event"]["value"], folder_id)
            self.assertEqual(events[1]["event"]["property"], "name")
            self.assertEqual(events[1]["event"]["value"], expected_name)

            channel.refresh_from_db()
            self.assertEqual(channel.name, expected_name)
            self.assertEqual(channel.folder_id, folder_id)
            # The channel is still found by its ID.
            result = self.client_get(f"/json/streams/{channel.id}")
            self.assertEqual(self.assert_json_success(result)["stream"]["name"], expected_name)

            audit_log = RealmAuditLog.objects.filter(
                event_type=AuditLogEventType.CHANNEL_NAME_CHANGED, modified_stream=channel
            ).latest("id")
            self.assertEqual(audit_log.acting_user, self.iago)
            self.assertEqual(
                audit_log.extra_data,
                {RealmAuditLog.OLD_VALUE: old_name, RealmAuditLog.NEW_VALUE: expected_name},
            )

        move_channel(self.support_folder, "Support/General")
        move_channel(self.development_folder, "Development/General")
        move_channel(None, "General")

        # Unlike renaming a channel, moving it posts no message in it.
        self.assertEqual(self.get_last_message().id, last_message_id)

    def test_moving_channel_to_folder_with_channel_of_same_name(self) -> None:
        self.make_channel_in_folder("General", self.support_folder)
        channel = self.make_stream("general")

        result = self.client_patch(
            f"/json/streams/{channel.id}",
            {"folder_id": orjson.dumps(self.support_folder.id).decode()},
        )
        self.assert_json_error(result, "Channel 'Support/general' already exists", status_code=409)
        channel.refresh_from_db()
        self.assertEqual(channel.name, "general")
        self.assertIsNone(channel.folder_id)

    def test_renaming_folder_renames_its_channels(self) -> None:
        general = self.make_channel_in_folder("General", self.support_folder)
        archived = self.make_channel_in_folder("Billing", self.support_folder)
        do_deactivate_stream(archived, acting_user=self.iago)
        other = self.make_channel_in_folder("General", self.development_folder)
        self.subscribe(self.iago, "Support/General")
        last_message_id = self.get_last_message().id

        with self.capture_send_event_calls(expected_num_events=3) as events:
            result = self.client_patch(
                f"/json/channel_folders/{self.support_folder.id}", {"name": "Help"}
            )
        self.assert_json_success(result)
        self.assertEqual(events[0]["event"]["type"], "channel_folder")
        self.assertEqual(
            {(event["event"]["stream_id"], event["event"]["value"]) for event in events[1:]},
            {(general.id, "Help/General"), (archived.id, "Help/Billing")},
        )

        for channel, expected_name in [
            (general, "Help/General"),
            (archived, "Help/Billing"),
            (other, "Development/General"),
        ]:
            channel.refresh_from_db()
            self.assertEqual(channel.name, expected_name)
        # No messages are posted about the channels being renamed.
        self.assertEqual(self.get_last_message().id, last_message_id)

        # A channel can have such a name from before it was reserved
        # for channels in folders.
        self.make_stream("Care/general")
        result = self.client_patch(
            f"/json/channel_folders/{self.support_folder.id}", {"name": "Care"}
        )
        self.assert_json_error(result, "Channel 'Care/general' already exists", status_code=409)
        self.support_folder.refresh_from_db()
        self.assertEqual(self.support_folder.name, "Help")
        general.refresh_from_db()
        self.assertEqual(general.name, "Help/General")


class PrivateChannelFoldersTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.iago = self.example_user("iago")
        self.realm = self.iago.realm
        self.cordelia = self.example_user("cordelia")
        self.hamlet = self.example_user("hamlet")
        self.othello = self.example_user("othello")
        self.polonius = self.example_user("polonius")
        self.folder = check_add_channel_folder(self.realm, "Secret", "", acting_user=self.iago)

    def set_folder_setting(self, setting_name: str, users: list[UserProfile]) -> None:
        do_change_channel_folder_group_based_setting(
            self.folder,
            setting_name,
            UserGroupMembersData(direct_members=[user.id for user in users], direct_subgroups=[]),
            acting_user=self.iago,
        )

    def visible_folder_ids(self, user: UserProfile) -> list[int]:
        result = self.api_get(user, "/api/v1/channel_folders")
        return [folder["id"] for folder in self.assert_json_success(result)["channel_folders"]]

    def audience_ids(self) -> set[int]:
        realm_admins = {self.iago.id, self.example_user("desdemona").id}
        return realm_admins | {self.cordelia.id, self.polonius.id}

    def test_creating_private_folder(self) -> None:
        self.login_user(self.hamlet)
        params = {
            "name": "Design",
            "description": "",
            "can_access_group": orjson.dumps(
                {"direct_members": [self.cordelia.id], "direct_subgroups": []}
            ).decode(),
        }
        with self.capture_send_event_calls(expected_num_events=1) as events:
            result = self.client_post("/json/channel_folders/create", params)
        folder = ChannelFolder.objects.get(id=self.assert_json_success(result)["channel_folder_id"])
        self.assertEqual(
            list(folder.can_access_group.direct_members.values_list("id", flat=True)),
            [self.cordelia.id],
        )
        # The creator sees the folder as its administrator.
        self.assertEqual(
            set(events[0]["users"]),
            {self.iago.id, self.example_user("desdemona").id, self.cordelia.id, self.hamlet.id},
        )

        moderators = NamedUserGroup.objects.get(
            name=SystemGroups.MODERATORS, realm_for_sharding=self.realm, is_system_group=True
        )
        params = {
            "name": "Moderation",
            "description": "",
            "can_access_group": orjson.dumps(moderators.id).decode(),
        }
        result = self.client_post("/json/channel_folders/create", params)
        folder = ChannelFolder.objects.get(id=self.assert_json_success(result)["channel_folder_id"])
        self.assertEqual(folder.can_access_group_id, moderators.id)

        # Folders are public by default.
        result = self.client_post(
            "/json/channel_folders/create", {"name": "Open", "description": ""}
        )
        folder = ChannelFolder.objects.get(id=self.assert_json_success(result)["channel_folder_id"])
        self.assertEqual(folder.can_access_group.named_user_group.name, SystemGroups.EVERYONE)

    def test_who_can_see_private_folder(self) -> None:
        self.set_folder_setting("can_access_group", [self.cordelia, self.polonius])
        self.set_folder_setting("can_administer_group", [self.othello])

        # Those allowed, including guests, administrators of the folder
        # and administrators of the organization see the folder.
        for user in [self.cordelia, self.polonius, self.othello, self.iago]:
            self.assertIn(self.folder.id, self.visible_folder_ids(user))
        for user in [self.hamlet, self.example_user("prospero")]:
            self.assertNotIn(self.folder.id, self.visible_folder_ids(user))

        # Guests cannot see a folder by administering it.
        self.set_folder_setting("can_administer_group", [self.othello, self.polonius])
        self.set_folder_setting("can_access_group", [self.cordelia])
        self.assertNotIn(self.folder.id, self.visible_folder_ids(self.polonius))

        # Those who cannot see a folder cannot change it either, and
        # learn nothing about it from trying.
        result = self.api_patch(
            self.hamlet, f"/api/v1/channel_folders/{self.folder.id}", {"name": "Public"}
        )
        self.assert_json_error(result, "Invalid channel folder ID")

    def test_events_for_private_folder(self) -> None:
        self.set_folder_setting("can_access_group", [self.cordelia, self.polonius])

        with self.capture_send_event_calls(expected_num_events=1) as events:
            do_change_channel_folder_name(self.folder, "Hidden", acting_user=self.iago)
        self.assertEqual(set(events[0]["users"]), self.audience_ids())

        other_folder = check_add_channel_folder(self.realm, "Open", "", acting_user=self.iago)
        all_folder_ids = list(
            ChannelFolder.objects.filter(realm=self.realm)
            .order_by("-id")
            .values_list("id", flat=True)
        )
        with self.capture_send_event_calls(expected_num_events=2) as events:
            try_reorder_realm_channel_folders(self.realm, all_folder_ids)
        orders = {tuple(event["event"]["order"]): set(event["users"]) for event in events}
        self.assertEqual(orders[tuple(all_folder_ids)], self.audience_ids())
        visible_order = tuple(
            folder_id for folder_id in all_folder_ids if folder_id != self.folder.id
        )
        self.assertIn(self.hamlet.id, orders[visible_order])
        self.assertIn(other_folder.id, visible_order)

    def test_channels_everyone_can_see_cannot_be_in_private_folder(self) -> None:
        self.login_user(self.iago)
        web_public = self.make_stream("public news", is_web_public=True)
        do_change_stream_folder(web_public, self.folder, acting_user=self.iago)
        params = {
            "can_access_group": orjson.dumps(
                {"new": {"direct_members": [self.cordelia.id], "direct_subgroups": []}}
            ).decode()
        }
        result = self.client_patch(f"/json/channel_folders/{self.folder.id}", params)
        self.assert_json_error(
            result, "A channel folder with web-public channels cannot be private."
        )

        do_change_stream_folder(web_public, None, acting_user=self.iago)
        default_channel = self.make_stream("welcome")
        do_add_default_stream(default_channel)
        do_change_stream_folder(default_channel, self.folder, acting_user=self.iago)
        result = self.client_patch(f"/json/channel_folders/{self.folder.id}", params)
        self.assert_json_error(result, "A channel folder with default channels cannot be private.")

        do_change_stream_folder(default_channel, None, acting_user=self.iago)
        self.assert_json_success(
            self.client_patch(f"/json/channel_folders/{self.folder.id}", params)
        )

        # Nor can such channels be put in the private folder.
        folder_id = orjson.dumps(self.folder.id).decode()
        for channel, error in [
            (web_public, "Web-public channels cannot be in a private channel folder."),
            (default_channel, "Default channels cannot be in a private channel folder."),
        ]:
            result = self.client_patch(f"/json/streams/{channel.id}", {"folder_id": folder_id})
            self.assert_json_error(result, error)

        result = self.create_channel_via_post(
            self.iago,
            name="announcements",
            is_web_public=True,
            extra_post_data={"folder_id": folder_id},
        )
        self.assert_json_error(result, "Web-public channels cannot be in a private channel folder.")
        result = self.subscribe_via_post(
            self.iago,
            ["announcements"],
            {"folder_id": folder_id, "is_default_stream": "true"},
            allow_fail=True,
        )
        self.assert_json_error(result, "Default channels cannot be in a private channel folder.")

        # A channel in the private folder cannot become one.
        channel = self.make_stream("plans")
        do_change_stream_folder(channel, self.folder, acting_user=self.iago)
        result = self.client_patch(
            f"/json/streams/{channel.id}", {"is_web_public": "true", "is_private": "false"}
        )
        self.assert_json_error(result, "Web-public channels cannot be in a private channel folder.")
        result = self.client_patch(f"/json/streams/{channel.id}", {"is_default_stream": "true"})
        self.assert_json_error(result, "Default channels cannot be in a private channel folder.")
        result = self.client_post("/json/default_streams", {"stream_id": channel.id})
        self.assert_json_error(result, "Default channels cannot be in a private channel folder.")

        # All of this is fine in a public folder.
        public_folder = check_add_channel_folder(self.realm, "Open", "", acting_user=self.iago)
        result = self.client_patch(
            f"/json/streams/{web_public.id}",
            {"folder_id": orjson.dumps(public_folder.id).decode()},
        )
        self.assert_json_success(result)


class PrivateFolderChannelAccessTest(ZulipTestCase):
    """Channels in a private folder are only accessible to those who
    can see the folder, in addition to the permissions of each channel.
    """

    @override
    def setUp(self) -> None:
        super().setUp()
        self.iago = self.example_user("iago")
        self.realm = self.iago.realm
        self.cordelia = self.example_user("cordelia")
        self.hamlet = self.example_user("hamlet")
        self.polonius = self.example_user("polonius")
        self.folder = check_add_channel_folder(self.realm, "Secret", "", acting_user=self.iago)
        do_change_channel_folder_group_based_setting(
            self.folder,
            "can_access_group",
            UserGroupMembersData(
                direct_members=[self.cordelia.id, self.polonius.id], direct_subgroups=[]
            ),
            acting_user=self.iago,
        )
        self.channel = self.make_stream("plans")
        do_change_stream_folder(self.channel, self.folder, acting_user=self.iago)
        self.channel.refresh_from_db()
        self.subscribe(self.iago, self.channel.name)
        self.message_id = self.send_stream_message(self.iago, self.channel.name, "the plan")

    def fetch_channel_messages(self, user: UserProfile, operand: str | int) -> "TestHttpResponse":
        return self.api_get(
            user,
            "/api/v1/messages",
            {
                "anchor": "newest",
                "num_before": 10,
                "num_after": 0,
                "narrow": orjson.dumps([{"operator": "channel", "operand": operand}]).decode(),
            },
        )

    def registered_channel_ids(self, user: UserProfile) -> set[int]:
        sub_info = gather_subscriptions_helper(user)
        return (
            {channel["stream_id"] for channel in sub_info.subscriptions}
            | {channel["stream_id"] for channel in sub_info.unsubscribed}
            | {channel["stream_id"] for channel in sub_info.never_subscribed}
        )

    def test_member_of_folder_accesses_public_channel(self) -> None:
        result = self.api_get(self.cordelia, f"/api/v1/streams/{self.channel.id}")
        self.assertEqual(self.assert_json_success(result)["stream"]["name"], self.channel.name)
        result = self.fetch_channel_messages(self.cordelia, self.channel.id)
        self.assertIn(
            self.message_id, [m["id"] for m in self.assert_json_success(result)["messages"]]
        )
        self.assertIn(self.channel.id, self.registered_channel_ids(self.cordelia))
        # They can send to it without subscribing, like to any public channel.
        check_send_stream_message(
            self.cordelia, get_client("test"), self.channel.name, "x", "my plan"
        )

        # A private channel in the folder still needs access to it.
        private_channel = self.make_stream("private plans", invite_only=True)
        do_change_stream_folder(private_channel, self.folder, acting_user=self.iago)
        result = self.api_get(self.cordelia, f"/api/v1/streams/{private_channel.id}")
        self.assert_json_error(result, "Invalid channel ID")

    def test_others_cannot_see_channel(self) -> None:
        for user in [self.hamlet, self.example_user("prospero")]:
            result = self.api_get(user, f"/api/v1/streams/{self.channel.id}")
            self.assert_json_error(result, "Invalid channel ID")
            self.assertNotIn(self.channel.id, self.registered_channel_ids(user))

        result = self.api_get(self.hamlet, "/api/v1/streams")
        self.assertNotIn(
            self.channel.id, [s["stream_id"] for s in self.assert_json_success(result)["streams"]]
        )
        result = self.api_get(self.hamlet, f"/api/v1/users/me/{self.channel.id}/topics")
        self.assert_json_error(result, "Invalid channel ID")
        result = self.api_get(self.hamlet, f"/api/v1/streams/{self.channel.id}/members")
        self.assert_json_error(result, "Invalid channel ID")

        # Messages, by ID, in the channel and in all public channels.
        result = self.api_get(self.hamlet, f"/api/v1/messages/{self.message_id}")
        self.assert_json_error(result, "Invalid message(s)")
        result = self.fetch_channel_messages(self.hamlet, self.channel.id)
        self.assertEqual(self.assert_json_success(result)["messages"], [])
        result = self.api_get(
            self.hamlet,
            "/api/v1/messages",
            {
                "anchor": "newest",
                "num_before": 100,
                "num_after": 0,
                "narrow": orjson.dumps([{"operator": "channels", "operand": "public"}]).decode(),
            },
        )
        self.assertNotIn(
            self.message_id, [m["id"] for m in self.assert_json_success(result)["messages"]]
        )
        result = self.api_get(
            self.hamlet,
            "/api/v1/messages",
            {
                "anchor": "newest",
                "num_before": 100,
                "num_after": 0,
                "narrow": orjson.dumps([{"operator": "search", "operand": "plan"}]).decode(),
            },
        )
        self.assertNotIn(
            self.message_id, [m["id"] for m in self.assert_json_success(result)["messages"]]
        )

        # Nor send to it or subscribe to it.
        result = self.api_post(
            self.hamlet,
            "/api/v1/messages",
            {"type": "channel", "to": self.channel.name, "topic": "x", "content": "hi"},
        )
        self.assert_json_error(result, f"Not authorized to send to channel '{self.channel.name}'")
        result = self.subscribe_via_post(self.hamlet, [self.channel.name], allow_fail=True)
        self.assert_json_error(result, f"Unable to access channel ({self.channel.name}).")

        # Nor create a channel in the folder.
        result = self.create_channel_via_post(
            self.hamlet,
            name="more plans",
            extra_post_data={"folder_id": orjson.dumps(self.folder.id).decode()},
        )
        self.assert_json_error(result, "Invalid channel folder ID")

    def test_events_about_channel(self) -> None:
        audience = {
            self.iago.id,
            self.example_user("desdemona").id,
            self.cordelia.id,
            self.polonius.id,
        }

        # The other event is the notice about the change in the channel.
        with self.capture_send_event_calls(expected_num_events=2) as events:
            do_change_stream_description(self.channel, "Our plans", acting_user=self.iago)
        # Guests only get events about channels they are subscribed to.
        self.assertEqual(set(events[0]["users"]), audience - {self.polonius.id})

        with self.capture_send_event_calls(expected_num_events=2) as events:
            self.subscribe(self.cordelia, self.channel.name)
        peer_add = [event for event in events if event["event"]["op"] == "peer_add"]
        self.assertEqual(set(peer_add[0]["users"]), audience - {self.polonius.id, self.cordelia.id})

        with self.capture_send_event_calls(expected_num_events=1) as events:
            create_stream_if_needed(self.realm, "new plans", folder=self.folder)
        self.assertEqual(set(events[0]["users"]), audience - {self.polonius.id})

    def test_guest_in_folder_reads_subscribed_channel(self) -> None:
        result = self.fetch_channel_messages(self.polonius, self.channel.id)
        self.assertEqual(self.assert_json_success(result)["messages"], [])

        self.subscribe(self.polonius, self.channel.name)
        result = self.fetch_channel_messages(self.polonius, self.channel.id)
        self.assertIn(
            self.message_id, [m["id"] for m in self.assert_json_success(result)["messages"]]
        )

    def test_folder_administrator_needs_access_to_private_channel(self) -> None:
        othello = self.example_user("othello")
        do_change_channel_folder_group_based_setting(
            self.folder,
            "can_administer_group",
            UserGroupMembersData(direct_members=[othello.id], direct_subgroups=[]),
            acting_user=self.iago,
        )
        private_channel = self.make_stream("private plans", invite_only=True)
        do_change_stream_folder(private_channel, self.folder, acting_user=self.iago)
        self.subscribe(self.iago, private_channel.name)
        message_id = self.send_stream_message(self.iago, private_channel.name)

        result = self.api_get(othello, f"/api/v1/messages/{message_id}")
        self.assert_json_error(result, "Invalid message(s)")
        # The public channel of the folder is accessible to them.
        result = self.api_get(othello, f"/api/v1/messages/{self.message_id}")
        self.assert_json_success(result)

    def test_subscribing_others_who_cannot_see_folder(self) -> None:
        result = self.subscribe_via_post(
            self.iago,
            [self.channel.name],
            {"principals": orjson.dumps([self.hamlet.id]).decode()},
            allow_fail=True,
        )
        self.assert_json_error(
            result,
            f"{self.hamlet.full_name} cannot see the channel folder of #{self.channel.name}.",
        )
        self.assertNotIn(
            self.hamlet, self.users_subscribed_to_stream(self.channel.name, self.realm)
        )

        result = self.create_channel_via_post(
            self.iago,
            subscribers=[self.iago.id, self.hamlet.id],
            name="more plans",
            extra_post_data={"folder_id": orjson.dumps(self.folder.id).decode()},
        )
        self.assert_json_error(
            result, f"{self.hamlet.full_name} cannot see the channel folder of #Secret/more plans."
        )
        self.assertFalse(Stream.objects.filter(name="Secret/more plans").exists())

        # Other ways to subscribe leave out those who cannot see the folder.
        bulk_add_subscriptions(self.realm, [self.channel], [self.hamlet], acting_user=None)
        self.assertNotIn(
            self.hamlet, self.users_subscribed_to_stream(self.channel.name, self.realm)
        )
