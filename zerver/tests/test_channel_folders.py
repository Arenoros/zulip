from typing import TYPE_CHECKING, Any

import orjson
from typing_extensions import override

from zerver.actions.channel_folders import (
    check_add_channel_folder,
    do_archive_channel_folder,
    do_change_channel_folder_group_based_setting,
    try_reorder_realm_channel_folders,
)
from zerver.actions.streams import (
    do_change_stream_folder,
    do_change_stream_group_based_setting,
    do_deactivate_stream,
)
from zerver.actions.user_groups import check_add_user_group
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.types import UserGroupMembersData
from zerver.models import ChannelFolder, NamedUserGroup, RealmAuditLog, Stream, UserProfile
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
