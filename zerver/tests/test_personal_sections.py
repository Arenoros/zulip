import orjson

from zerver.lib.personal_sections import get_personal_sections
from zerver.lib.test_classes import ZulipTestCase
from zerver.models import PersonalSections


class PersonalSectionsTests(ZulipTestCase):
    def test_update_personal_sections(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        self.login_user(hamlet)

        conversation_sections = [
            {"name": " Project ", "conversations": [[cordelia.id], [cordelia.id, othello.id]]},
            # The conversation with oneself has no other participants.
            {"name": "Notes", "conversations": [[]]},
        ]
        expected_sections = [
            {"name": "Project", "conversations": [[cordelia.id], [cordelia.id, othello.id]]},
            {"name": "Notes", "conversations": [[]]},
        ]
        with self.capture_send_event_calls(expected_num_events=1) as events:
            result = self.client_patch(
                "/json/users/me/personal_sections",
                {"conversation_sections": orjson.dumps(conversation_sections).decode()},
            )
        self.assert_json_success(result)
        self.assertEqual(events[0]["users"], [hamlet.id])
        self.assertEqual(
            events[0]["event"],
            dict(
                type="personal_sections",
                op="update",
                conversation_sections=expected_sections,
            ),
        )
        self.assertEqual(
            get_personal_sections(hamlet), dict(conversation_sections=expected_sections)
        )

        # The sections are replaced as a whole.
        result = self.client_patch(
            "/json/users/me/personal_sections",
            {
                "conversation_sections": orjson.dumps(
                    [{"name": "Team", "conversations": [[cordelia.id]]}]
                ).decode()
            },
        )
        self.assert_json_success(result)
        self.assertEqual(
            get_personal_sections(hamlet),
            dict(conversation_sections=[{"name": "Team", "conversations": [[cordelia.id]]}]),
        )

        # Other users have their own sections.
        self.assertEqual(get_personal_sections(cordelia), dict(conversation_sections=[]))
        self.assertEqual(PersonalSections.objects.count(), 1)

    def test_update_personal_sections_errors(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        othello = self.example_user("othello")
        self.login_user(hamlet)

        def assert_rejected(sections: list[dict[str, object]], msg: str) -> None:
            result = self.client_patch(
                "/json/users/me/personal_sections",
                {"conversation_sections": orjson.dumps(sections).decode()},
            )
            self.assert_json_error_contains(result, msg)

        result = self.client_patch("/json/users/me/personal_sections")
        self.assert_json_error(result, "Missing 'conversation_sections' argument")

        assert_rejected(
            [
                {"name": "Project", "conversations": []},
                {"name": "project ", "conversations": []},
            ],
            "Section names must be unique.",
        )
        assert_rejected(
            [
                {"name": "Project", "conversations": [[cordelia.id, othello.id]]},
                {"name": "Friends", "conversations": [[cordelia.id, othello.id]]},
            ],
            "An item can only be in one section.",
        )
        assert_rejected(
            [{"name": "Project", "conversations": [[othello.id, cordelia.id]]}],
            "user IDs must be unique and in ascending order",
        )
        assert_rejected(
            [
                {
                    "name": "Project",
                    "conversations": [list(range(1, PersonalSections.MAX_CONVERSATION_USERS + 2))],
                }
            ],
            "conversation_sections[0]",
        )
        assert_rejected([{"name": " ", "conversations": []}], "conversation_sections[0]")
        assert_rejected(
            [{"name": "a" * (PersonalSections.MAX_SECTION_NAME_LENGTH + 1), "conversations": []}],
            "conversation_sections[0]",
        )
        assert_rejected(
            [
                {"name": f"Section {i}", "conversations": []}
                for i in range(PersonalSections.MAX_SECTIONS + 1)
            ],
            "Too many sections (limit: 50).",
        )
        assert_rejected(
            [
                {
                    "name": "Team",
                    "conversations": [[i] for i in range(1, PersonalSections.MAX_ITEMS + 2)],
                }
            ],
            "Too many items in sections (limit: 500).",
        )

        self.assertFalse(PersonalSections.objects.exists())
