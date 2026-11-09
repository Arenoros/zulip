import hashlib
from base64 import b64encode
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from unittest import mock

import jwt
import orjson
import requests
import responses
import time_machine
from django.core.signing import Signer
from django.http import HttpResponseRedirect
from django.test import override_settings
from typing_extensions import override

from zerver.actions.muted_users import do_mute_user
from zerver.actions.realm_settings import do_set_realm_property
from zerver.lib.test_classes import ZulipTestCase
from zerver.lib.url_encoding import append_url_query_string
from zerver.models import LiveKitCall, Realm, UserProfile
from zerver.models.realms import get_realm
from zerver.models.streams import get_stream
from zerver.views.video_calls import LIVEKIT_TOKEN_LIFETIME_SECONDS

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse as TestHttpResponse


@override_settings(VIDEO_ZOOM_SERVER_TO_SERVER_ACCOUNT_ID=None)
class ZoomVideoCallTestUserAuth(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user = self.example_user("hamlet")
        self.login_user(self.user)

    def test_register_zoom_request_no_settings(self) -> None:
        with self.settings(VIDEO_ZOOM_CLIENT_ID=None):
            response = self.client_get("/calls/zoom/register")
            self.assert_json_error(
                response,
                "Zoom credentials have not been configured",
            )

    def test_register_zoom_request(self) -> None:
        response = self.client_get("/calls/zoom/register")
        self.assertEqual(response.status_code, 302)

    @responses.activate
    def test_create_zoom_video_and_audio_links(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "oldtoken", "expires_in": -60},
        )

        response = self.client_get(
            "/calls/zoom/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

        # Test creating a video link
        responses.replace(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "newtoken", "expires_in": 60},
        )

        responses.add(
            responses.POST,
            "https://api.zoom.us/v2/users/me/meetings",
            json={"join_url": "example.com"},
        )

        response = self.client_post("/json/calls/zoom/create", {"is_video_call": "true"})
        self.assertEqual(
            responses.calls[-1].request.url,
            "https://api.zoom.us/v2/users/me/meetings",
        )
        assert responses.calls[-1].request.body is not None
        self.assertEqual(
            orjson.loads(responses.calls[-1].request.body),
            {
                "settings": {
                    "host_video": True,
                    "participant_video": True,
                },
                "default_password": True,
            },
        )
        self.assertEqual(
            responses.calls[-1].request.headers["Authorization"],
            "Bearer newtoken",
        )
        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "example.com")

        # Test creating an audio link
        responses.replace(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "newtoken", "expires_in": 60},
        )

        responses.add(
            responses.POST,
            "https://api.zoom.us/v2/users/me/meetings",
            json={"join_url": "example.com"},
        )

        response = self.client_post("/json/calls/zoom/create", {"is_video_call": "false"})
        self.assertEqual(
            responses.calls[-1].request.url,
            "https://api.zoom.us/v2/users/me/meetings",
        )
        self.assertEqual(
            orjson.loads(responses.calls[-1].request.body),
            {
                "settings": {
                    "host_video": False,
                    "participant_video": False,
                },
                "default_password": True,
            },
        )
        self.assertEqual(
            responses.calls[-1].request.headers["Authorization"],
            "Bearer newtoken",
        )
        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "example.com")

        # Test for authentication error
        self.logout()
        self.login_user(self.user)

        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Invalid Zoom access token")

    def test_create_zoom_realm_redirect(self) -> None:
        response = self.client_get(
            "/calls/zoom/complete",
            {"code": "code", "state": '{"realm":"zephyr","sid":"somesid"}'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("http://zephyr.testserver/", response["Location"])
        self.assertIn("somesid", response["Location"])

    def test_create_zoom_sid_error(self) -> None:
        response = self.client_get(
            "/calls/zoom/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":"bad"}'},
        )
        self.assert_json_error(response, "Invalid Zoom session identifier")

    @responses.activate
    def test_create_zoom_credential_error(self) -> None:
        responses.add(responses.POST, "https://zoom.example.com/oauth/token", status=400)

        response = self.client_get(
            "/calls/zoom/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assert_json_error(response, "Invalid Zoom credentials")

    @responses.activate
    def test_create_zoom_refresh_error(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token", "expires_in": -60},
        )

        response = self.client_get(
            "/calls/zoom/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

        responses.replace(responses.POST, "https://zoom.example.com/oauth/token", status=400)

        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Invalid Zoom access token")

    @responses.activate
    def test_create_zoom_request_error(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token"},
        )

        responses.add(
            responses.POST,
            "https://api.zoom.us/v2/users/me/meetings",
            status=400,
        )

        response = self.client_get(
            "/calls/zoom/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Failed to create Zoom call")

        responses.replace(
            responses.POST,
            "https://api.zoom.us/v2/users/me/meetings",
            status=401,
        )

        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Invalid Zoom access token")

    @responses.activate
    def test_deauthorize_zoom_user(self) -> None:
        response = self.client_post(
            "/calls/zoom/deauthorize",
            """\
{
  "event": "app_deauthorized",
  "payload": {
    "user_data_retention": "false",
    "account_id": "EabCDEFghiLHMA",
    "user_id": "z9jkdsfsdfjhdkfjQ",
    "signature": "827edc3452044f0bc86bdd5684afb7d1e6becfa1a767f24df1b287853cf73000",
    "deauthorization_time": "2019-06-17T13:52:28.632Z",
    "client_id": "ADZ9k9bTWmGUoUbECUKU_a"
  }
}
""",
            content_type="application/json",
        )
        self.assert_json_success(response)


class WebexVideoCallTestOAuth(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user = self.example_user("hamlet")
        self.login_user(self.user)

    def test_register_webex_request_no_settings(self) -> None:
        with self.settings(VIDEO_WEBEX_CLIENT_ID=None):
            response = self.client_get("/calls/webex/register")
            self.assert_json_error(
                response,
                "Webex credentials have not been configured",
            )

    def test_register_webex_request(self) -> None:
        response = self.client_get("/calls/webex/register")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("https://webexapis.com/v1/authorize"))

    @responses.activate
    def test_create_webex_access_token(self) -> None:
        responses.add(
            responses.POST,
            "https://webexapis.com/v1/access_token",
            json={"access_token": "oldtoken", "expires_in": -60},
        )

        response = self.client_get(
            "/calls/webex/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

    @responses.activate
    def test_create_webex_adhoc_meeting(self) -> None:
        responses.add(
            responses.POST,
            "https://webexapis.com/v1/access_token",
            json={"access_token": "token", "expires_in": 3600},
        )

        response = self.client_get(
            "/calls/webex/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

        responses.add(
            responses.POST,
            "https://webexapis.com/v1/rooms",
            json={"id": "room_id_123"},
            status=200,
        )

        responses.add(
            responses.POST,
            "https://webexapis.com/v1/meetings",
            json={
                "id": "meeting_id_456",
                "webLink": "https://webex.com/test",
            },
            status=200,
        )

        response = self.client_post("/json/calls/webex/create")

        result = self.assert_json_success(response)
        self.assertEqual(result["url"], "https://webex.com/test")

        # Test for token removal on logout.
        self.logout()
        self.login_user(self.user)

        response = self.client_post("/json/calls/webex/create")
        self.assert_json_error(response, "Invalid Webex access token")

    @responses.activate
    def test_create_webex_personal_room_meeting(self) -> None:
        responses.add(
            responses.POST,
            "https://webexapis.com/v1/access_token",
            json={"access_token": "token", "expires_in": 3600},
        )

        self.client_get(
            "/calls/webex/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )

        responses.add(
            responses.POST,
            "https://webexapis.com/v1/rooms",
            status=403,
        )

        responses.add(
            responses.POST,
            "https://webexapis.com/v1/meetings",
            json={
                "id": "meeting_id_456",
                "webLink": "https://webex.com/test",
            },
            status=200,
        )

        result = self.client_post("/json/calls/webex/create")

        assert responses.calls[-1].request.body is not None
        payload = orjson.loads(responses.calls[-1].request.body)
        self.assertEqual(payload["scheduledType"], "personalRoomMeeting")

        json = self.assert_json_success(result)
        self.assertEqual(json["url"], "https://webex.com/test")

    def test_create_webex_realm_redirect(self) -> None:
        response = self.client_get(
            "/calls/webex/complete",
            {"code": "code", "state": '{"realm":"lear","sid":"somesid"}'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("http://lear.testserver/", response["Location"])
        self.assertIn("somesid", response["Location"])

    @responses.activate
    def test_webex_public_room_creation_failure(self) -> None:
        responses.add(
            responses.POST,
            "https://webexapis.com/v1/access_token",
            json={"access_token": "token", "expires_in": 3600},
        )

        self.client_get(
            "/calls/webex/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )

        responses.add(
            responses.POST,
            "https://webexapis.com/v1/rooms",
            status=500,
        )

        response = self.client_post("/json/calls/webex/create")

        self.assert_json_error(response, "Failed to create Webex public room.")


class ZoomVideoCallTestServerAuth(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user = self.example_user("hamlet")
        self.login_user(self.user)
        self.user_zoom_meeting_url = (
            f"https://api.zoom.us/v2/users/{self.user.delivery_email}/meetings"
        )

    @responses.activate
    def test_zoom_invalid_settings(self) -> None:
        with self.settings(VIDEO_ZOOM_CLIENT_ID=None):
            response = self.client_post("/json/calls/zoom/create")
            self.assert_json_error(
                response,
                "Zoom credentials have not been configured",
            )

        responses.add(responses.POST, "https://zoom.example.com/oauth/token", status=400)
        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Invalid Zoom credentials")

    @responses.activate
    def test_zoom_invalid_access_token_error(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token"},
        )

        responses.add(
            responses.POST,
            self.user_zoom_meeting_url,
            status=400,
            json={"code": 124, "message": "API key expired"},
        )
        with self.assertLogs(level="ERROR") as error_log:
            response = self.client_post("/json/calls/zoom/create")
            self.assertEqual(
                error_log.output[0],
                "ERROR:root:Unexpected Zoom error 124: API key expired",
            )
        self.assert_json_error(response, "Failed to create Zoom call")

    @responses.activate
    def test_zoom_unknown_email_error(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token"},
        )

        responses.add(responses.POST, self.user_zoom_meeting_url, status=400, json={"code": 1001})
        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Unknown Zoom user email")

    @responses.activate
    def test_zoom_error_api_response_code_unknown(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token"},
        )

        responses.add(responses.POST, self.user_zoom_meeting_url, status=400, json={"code": 300})
        response = self.client_post("/json/calls/zoom/create")
        self.assert_json_error(response, "Failed to create Zoom call")

    @responses.activate
    def test_zoom_create_video_call(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token", "expires_in": 3599},
        )

        responses.add(
            responses.POST,
            self.user_zoom_meeting_url,
            json={"join_url": "example.com"},
        )

        response = self.client_post("/json/calls/zoom/create", {"is_video_call": "true"})
        self.assertEqual(
            responses.calls[-1].request.url,
            self.user_zoom_meeting_url,
        )
        assert responses.calls[-1].request.body is not None
        self.assertEqual(
            orjson.loads(responses.calls[-1].request.body),
            {
                "settings": {
                    "host_video": True,
                    "participant_video": True,
                },
                "default_password": True,
            },
        )
        self.assertEqual(
            responses.calls[-1].request.headers["Authorization"],
            "Bearer token",
        )
        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "example.com")

    @responses.activate
    def test_zoom_create_audio_call(self) -> None:
        responses.add(
            responses.POST,
            "https://zoom.example.com/oauth/token",
            json={"access_token": "token", "expires_in": 3599},
        )

        responses.add(
            responses.POST,
            self.user_zoom_meeting_url,
            json={"join_url": "example.com"},
        )

        response = self.client_post("/json/calls/zoom/create", {"is_video_call": "false"})
        self.assertEqual(
            responses.calls[-1].request.url,
            self.user_zoom_meeting_url,
        )
        assert responses.calls[-1].request.body is not None
        self.assertEqual(
            orjson.loads(responses.calls[-1].request.body),
            {
                "settings": {
                    "host_video": False,
                    "participant_video": False,
                },
                "default_password": True,
            },
        )
        self.assertEqual(
            responses.calls[-1].request.headers["Authorization"],
            "Bearer token",
        )
        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "example.com")


class BigBlueButtonVideoCallTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user = self.example_user("hamlet")
        self.login_user(self.user)
        self.signer = Signer()
        self.signed_bbb_a_object = self.signer.sign_object(
            {
                "meeting_id": "a",
                "name": "a",
                "lock_settings_disable_cam": True,
                "moderator": self.user.id,
            }
        )
        # For testing viewer role (different creator / moderator from self)
        self.signed_bbb_a_object_different_creator = self.signer.sign_object(
            {
                "meeting_id": "a",
                "name": "a",
                "lock_settings_disable_cam": True,
                "moderator": self.example_user("cordelia").id,
            }
        )

    def test_create_bigbluebutton_link(self) -> None:
        with (
            mock.patch("zerver.views.video_calls.random.randint", return_value="1"),
            mock.patch("secrets.token_bytes", return_value=b"\x00" * 20),
        ):
            with mock.patch("zerver.views.video_calls.random.randint", return_value="1"):
                response = self.client_get(
                    "/json/calls/bigbluebutton/create?meeting_name=general > meeting&voice_only=false"
                )
            response_dict = self.assert_json_success(response)
            self.assertEqual(
                response_dict["url"],
                append_url_query_string(
                    "/calls/bigbluebutton/join",
                    "bigbluebutton="
                    + self.signer.sign_object(
                        {
                            "meeting_id": "zulip-1",
                            "name": "general > meeting",
                            "lock_settings_disable_cam": False,
                            "moderator": self.user.id,
                        }
                    ),
                ),
            )

            # Testing for audio call
            response = self.client_get(
                "/json/calls/bigbluebutton/create?meeting_name=general > meeting&voice_only=true"
            )
            response_dict = self.assert_json_success(response)
            self.assertEqual(
                response_dict["url"],
                append_url_query_string(
                    "/calls/bigbluebutton/join",
                    "bigbluebutton="
                    + self.signer.sign_object(
                        {
                            "meeting_id": "zulip-1",
                            "name": "general > meeting",
                            "lock_settings_disable_cam": True,
                            "moderator": self.user.id,
                        }
                    ),
                ),
            )

    @responses.activate
    def test_join_bigbluebutton_redirect(self) -> None:
        responses.add(
            responses.GET,
            "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True"
            "&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20",
            "<response><returncode>SUCCESS</returncode><messageKey/><createTime>0</createTime></response>",
        )
        response = self.client_get(
            "/calls/bigbluebutton/join", {"bigbluebutton": self.signed_bbb_a_object}
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(isinstance(response, HttpResponseRedirect), True)
        self.assertEqual(
            response["Location"],
            "https://bbb.example.com/bigbluebutton/api/join?meetingID=a&"
            "role=MODERATOR&fullName=King%20Hamlet&createTime=0&checksum=54259b884a7c20ddcd7b280a1b62e59d7990568fe4f22001812bc4bcfd161a46",
        )
        # Testing for viewer role
        response = self.client_get(
            "/calls/bigbluebutton/join",
            {"bigbluebutton": self.signed_bbb_a_object_different_creator},
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(isinstance(response, HttpResponseRedirect), True)
        self.assertEqual(
            response["Location"],
            "https://bbb.example.com/bigbluebutton/api/join?meetingID=a&"
            "role=VIEWER&fullName=King%20Hamlet&createTime=0&checksum=52efaf64109ca4ec5a20a1d295f315af53f9e6ec30b50ed3707fd2909ac6bd94",
        )

    @responses.activate
    def test_join_bigbluebutton_invalid_signature(self) -> None:
        responses.add(
            responses.GET,
            "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True"
            "&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20",
            "<response><returncode>SUCCESS</returncode><messageKey/><createTime>0</createTime></response>",
        )
        response = self.client_get(
            "/calls/bigbluebutton/join", {"bigbluebutton": self.signed_bbb_a_object + "zoo"}
        )
        self.assert_json_error(response, "Invalid signature.")

    @responses.activate
    def test_join_bigbluebutton_redirect_wrong_big_blue_button_checksum(self) -> None:
        responses.add(
            responses.GET,
            "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20",
            "<response><returncode>FAILED</returncode><messageKey>checksumError</messageKey>"
            "<message>You did not pass the checksum security check</message></response>",
        )
        response = self.client_get(
            "/calls/bigbluebutton/join",
            {"bigbluebutton": self.signed_bbb_a_object},
        )
        self.assert_json_error(response, "Error authenticating to the BigBlueButton server")

    @responses.activate
    def test_join_bigbluebutton_redirect_server_error(self) -> None:
        # Simulate bbb server error
        responses.add(
            responses.GET,
            "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20",
            status=500,
            body="Something went wrong",
        )
        response = self.client_get(
            "/calls/bigbluebutton/join",
            {"bigbluebutton": self.signed_bbb_a_object},
        )
        self.assert_json_error(
            response, "Error connecting to the BigBlueButton server: HTTP 500: Something went wrong"
        )

    @responses.activate
    def test_join_bigbluebutton_connection_refused(self) -> None:
        responses.add(
            responses.GET,
            "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20",
            body=requests.exceptions.ConnectionError("Connection refused"),
        )
        response = self.client_get(
            "/calls/bigbluebutton/join",
            {"bigbluebutton": self.signed_bbb_a_object},
        )
        self.assert_json_error(
            response, "Error connecting to the BigBlueButton server: Connection refused"
        )

    @responses.activate
    def test_join_bigbluebutton_too_many_redirects(self) -> None:
        url = "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20"
        responses.add(
            responses.GET,
            url,
            status=302,
            headers={"Location": url},
            body="Redirecting",
        )
        response = self.client_get(
            "/calls/bigbluebutton/join",
            {"bigbluebutton": self.signed_bbb_a_object},
        )
        self.assert_json_error(
            response, "Error connecting to the BigBlueButton server: HTTP 302: Redirecting"
        )

    @responses.activate
    def test_join_bigbluebutton_redirect_error_by_server(self) -> None:
        # Simulate bbb server error
        responses.add(
            responses.GET,
            "https://bbb.example.com/bigbluebutton/api/create?meetingID=a&name=a&lockSettingsDisableCam=True&checksum=33349e6374ca9b2d15a0c6e51a42bc3e8f770de13f88660815c6449859856e20",
            "<response><returncode>FAILURE</returncode><messageKey>otherFailure</messageKey></response>",
        )
        response = self.client_get(
            "/calls/bigbluebutton/join",
            {"bigbluebutton": self.signed_bbb_a_object},
        )
        self.assert_json_error(
            response, "BigBlueButton server returned an unexpected error: FAILURE"
        )

    def test_join_bigbluebutton_redirect_not_configured(self) -> None:
        with self.settings(BIG_BLUE_BUTTON_SECRET=None, BIG_BLUE_BUTTON_URL=None):
            response = self.client_get(
                "/calls/bigbluebutton/join",
                {"bigbluebutton": self.signed_bbb_a_object},
            )
            self.assert_json_error(response, "BigBlueButton credentials have not been configured")


class ConstructorGroupsVideoCallTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user_profile = self.example_user("hamlet")
        self.login_user(self.user_profile)

        self.base_api_url = "https://example.constructor.app/api/groups/xapi"

        self.test_room_guid = "a13b8686-d383-4763-b3b7-d2d4dd7f34ec"
        self.test_room_name = "King Hamlet's Zulip room"
        self.test_room_url = f"https://example.constructor.app/groups/room/{self.test_room_name}"

        self.mock_valid_room = {
            "room_guid": self.test_room_guid,
            "name": self.test_room_name,
            "url": self.test_room_url,
        }

        self.mock_room_missing_url = {
            "room_guid": self.test_room_guid,
            "name": self.test_room_name,
        }

    def test_missing_constructor_groups_settings(self) -> None:
        for setting_name in [
            "CONSTRUCTOR_GROUPS_URL",
            "CONSTRUCTOR_GROUPS_ACCESS_KEY",
            "CONSTRUCTOR_GROUPS_SECRET_KEY",
        ]:
            with self.settings(**{setting_name: None}):
                response = self.client_post("/json/calls/constructorgroups/create")
                self.assert_json_error(
                    response, "Constructor Groups credentials have not been configured"
                )

    @responses.activate
    def test_get_existing_room(self) -> None:
        responses.add(
            responses.POST,
            f"{self.base_api_url}/room/default",
            json=self.mock_valid_room,
            status=200,
        )

        response = self.client_post("/json/calls/constructorgroups/create")

        response_dict = self.assert_json_success(response)
        self.assertEqual(response_dict["url"], self.test_room_url)
        self.assert_length(responses.calls, 1)

    @responses.activate
    def test_create_new_room(self) -> None:
        responses.add(
            responses.POST,
            f"{self.base_api_url}/room/default",
            json=self.mock_valid_room,
            status=201,
        )

        response = self.client_post("/json/calls/constructorgroups/create")

        response_dict = self.assert_json_success(response)
        self.assertEqual(response_dict["url"], self.test_room_url)
        self.assert_length(responses.calls, 1)

    @responses.activate
    def test_missing_url_in_response(self) -> None:
        responses.add(
            responses.POST,
            f"{self.base_api_url}/room/default",
            json=self.mock_room_missing_url,
            status=200,
        )

        with self.assertLogs(level="ERROR") as logs:
            response = self.client_post("/json/calls/constructorgroups/create")

        self.assert_json_error(response, "Failed to create Constructor Groups call")
        self.assertIn("Constructor Groups API returned room without URL", logs.output[0])

    @responses.activate
    def test_http_request_error_handling(self) -> None:
        responses.add(
            responses.POST,
            f"{self.base_api_url}/room/default",
            status=500,
        )

        with self.assertLogs(level="ERROR") as error_log:
            response = self.client_post("/json/calls/constructorgroups/create")
            self.assertIn("Constructor Groups API request failed", error_log.output[0])
        self.assert_json_error(response, "Failed to create Constructor Groups call")

    @responses.activate
    def test_api_response_json_error(self) -> None:
        responses.add(
            responses.POST,
            f"{self.base_api_url}/room/default",
            body="invalid json",
            status=200,
        )

        with self.assertLogs(level="ERROR") as error_log:
            response = self.client_post("/json/calls/constructorgroups/create")
            self.assertIn("Constructor Groups API request failed", error_log.output[0])
        self.assert_json_error(response, "Failed to create Constructor Groups call")

    @responses.activate
    def test_request_contains_correct_data(self) -> None:
        responses.add(
            responses.POST,
            f"{self.base_api_url}/room/default",
            json=self.mock_valid_room,
            status=200,
        )

        response = self.client_post("/json/calls/constructorgroups/create")
        self.assert_json_success(response)

        # Verify request body
        assert responses.calls[0].request.body is not None
        request_body = orjson.loads(responses.calls[0].request.body)
        self.assertEqual(request_body["creator_email"], self.user_profile.delivery_email)
        self.assertEqual(request_body["name"], f"{self.user_profile.full_name}'s Zulip room")
        self.assertEqual(
            request_body["fallback_name"],
            f"{self.user_profile.full_name}'s Zulip room ({self.user_profile.realm_id}-{self.user_profile.id})",
        )

    def test_unsupported_http_method(self) -> None:
        from zerver.lib.exceptions import JsonableError
        from zerver.views.video_calls import ConstructorGroupsService

        service = ConstructorGroupsService()

        with self.assertLogs(level="ERROR") as error_log:
            with self.assertRaises(JsonableError) as cm:
                service._make_authenticated_request("GET", "/room/default")
            self.assertEqual(str(cm.exception.msg), "Failed to create Constructor Groups call")
            self.assertIn("Constructor Groups API request failed", error_log.output[0])


class NextcloudVideoCallTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user = self.example_user("hamlet")
        self.login_user(self.user)
        self.nextcloud_api_url = "https://nextcloud.example.com/ocs/v2.php/apps/spreed/api/v4/room"

    @responses.activate
    def test_create_nextcloud_talk_video_call_success(self) -> None:
        responses.add(
            responses.POST,
            self.nextcloud_api_url,
            json={
                "ocs": {
                    "meta": {"status": "ok", "statuscode": 200, "message": "OK"},
                    "data": {
                        "token": "abc123token",
                        "name": "Test Meeting",
                        "displayName": "Test Meeting",
                        "type": 3,
                    },
                }
            },
            status=200,
        )

        response = self.client_post(
            "/json/calls/nextcloud_talk/create", {"room_name": "#Test > team check-in"}
        )
        self.assertEqual(responses.calls[0].request.url, self.nextcloud_api_url)

        self.assertEqual(
            responses.calls[0].request.headers["OCS-APIRequest"],
            "true",
        )
        self.assertEqual(
            responses.calls[0].request.headers["Accept"],
            "application/json",
        )
        self.assertIn("Authorization", responses.calls[0].request.headers)
        self.assertTrue(responses.calls[0].request.headers["Authorization"].startswith("Basic "))

        assert responses.calls[0].request.body is not None
        self.assertEqual(
            orjson.loads(responses.calls[0].request.body),
            {
                "roomType": 3,
                "roomName": "#Test > team check-in",
            },
        )

        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "https://nextcloud.example.com/index.php/call/abc123token")

    def test_create_nextcloud_talk_not_configured(self) -> None:
        for setting_name in [
            "NEXTCLOUD_SERVER",
            "NEXTCLOUD_TALK_USERNAME",
            "NEXTCLOUD_TALK_PASSWORD",
        ]:
            with self.settings(**{setting_name: None}):
                response = self.client_post(
                    "/json/calls/nextcloud_talk/create",
                    {"room_name": "#Test > team check-in"},
                )
                self.assert_json_error(
                    response, "Nextcloud Talk credentials have not been configured"
                )

    @responses.activate
    def test_create_nextcloud_talk_server_error(self) -> None:
        responses.add(
            responses.POST,
            self.nextcloud_api_url,
            status=400,
            body="Invalid request",
        )

        response = self.client_post(
            "/json/calls/nextcloud_talk/create", {"room_name": "#Test > team check-in"}
        )

        self.assert_json_error(
            response, "Error connecting to the Nextcloud Talk server: HTTP 400: Invalid request"
        )

    @responses.activate
    def test_create_nextcloud_talk_connection_error(self) -> None:
        responses.add(
            responses.POST,
            self.nextcloud_api_url,
            body=requests.RequestException("Connection failed"),
        )

        response = self.client_post(
            "/json/calls/nextcloud_talk/create", {"room_name": "#Test > team check-in"}
        )

        self.assert_json_error(
            response, "Error connecting to the Nextcloud Talk server: Connection failed"
        )

    @responses.activate
    def test_create_nextcloud_talk_invalid_response(self) -> None:
        # Missing 'token' field
        responses.add(
            responses.POST,
            self.nextcloud_api_url,
            json={
                "ocs": {
                    "meta": {"status": "ok"},
                    "data": {},
                }
            },
            status=200,
        )

        response = self.client_post(
            "/json/calls/nextcloud_talk/create",
            {"room_name": "#Test > team check-in"},
        )
        self.assert_json_error(response, "Failed to create Nextcloud Talk call")

    @responses.activate
    def test_create_nextcloud_talk_truncates_long_room_name(self) -> None:
        responses.add(
            responses.POST,
            self.nextcloud_api_url,
            json={
                "ocs": {
                    "meta": {"status": "ok", "statuscode": 200, "message": "OK"},
                    "data": {
                        "token": "abc123token",
                        "name": "Truncated Conversation",
                        "displayName": "Truncated Meeting",
                        "type": 3,
                    },
                }
            },
            status=200,
        )

        long_room_name = "A" * 300

        response = self.client_post(
            "/json/calls/nextcloud_talk/create", {"room_name": long_room_name}
        )

        from zerver.views.video_calls import MAX_NEXTCLOUD_TALK_ROOM_NAME_LENGTH

        assert responses.calls[0].request.body is not None
        request_body = orjson.loads(responses.calls[0].request.body)
        self.assert_length(request_body["roomName"], MAX_NEXTCLOUD_TALK_ROOM_NAME_LENGTH)
        self.assertTrue(request_body["roomName"].endswith("..."))

        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "https://nextcloud.example.com/index.php/call/abc123token")


@override_settings(
    VIDEO_GOOGLE_MEET_CLIENT_ID="google_client_id",
    VIDEO_GOOGLE_MEET_CLIENT_SECRET="google_client_secret",
    VIDEO_GOOGLE_MEET_OAUTH_URL="https://googleoauth.example.com/o/oauth2/v2/auth",
    VIDEO_GOOGLE_MEET_TOKEN_URL="https://googletoken.example.com/token",
    VIDEO_GOOGLE_MEET_API_URL="https://meet.example.com/v2/spaces",
)
class GoogleMeetVideoCallTest(ZulipTestCase):
    @override
    def setUp(self) -> None:
        super().setUp()
        self.user = self.example_user("hamlet")
        self.login_user(self.user)

    def test_register_google_meet_no_settings(self) -> None:
        with self.settings(VIDEO_GOOGLE_MEET_CLIENT_ID=None):
            response = self.client_get("/calls/google_meet/register")
            self.assert_json_error(
                response,
                "Google Meet credentials have not been configured",
            )

    def test_register_google_meet_request(self) -> None:
        response = self.client_get("/calls/google_meet/register")
        self.assertEqual(response.status_code, 302)
        self.assertIn(
            "https://googleoauth.example.com/o/oauth2/v2/auth",
            response["Location"],
        )
        self.assertIn("access_type=offline", response["Location"])
        self.assertIn("prompt=consent", response["Location"])

    @responses.activate
    def test_create_google_meet_link(self) -> None:
        responses.add(
            responses.POST,
            "https://googletoken.example.com/token",
            json={"access_token": "token", "expires_in": 3600},
        )

        response = self.client_get(
            "/calls/google_meet/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

        responses.add(
            responses.POST,
            "https://meet.example.com/v2/spaces",
            json={"meetingUri": "https://meet.google.com/abc-mnop-xyz"},
        )

        response = self.client_post("/json/calls/google_meet/create")
        self.assertEqual(
            responses.calls[-1].request.url,
            "https://meet.example.com/v2/spaces",
        )
        self.assertEqual(
            responses.calls[-1].request.headers["Authorization"],
            "Bearer token",
        )
        json = self.assert_json_success(response)
        self.assertEqual(json["url"], "https://meet.google.com/abc-mnop-xyz")

        # Token is cleared on logout; subsequent call must re-authorize.
        self.logout()
        self.login_user(self.user)

        response = self.client_post("/json/calls/google_meet/create")
        self.assert_json_error(response, "Invalid Google Meet access token")

    def test_create_google_meet_realm_redirect(self) -> None:
        response = self.client_get(
            "/calls/google_meet/complete",
            {"code": "code", "state": '{"realm":"zephyr","sid":"somesid"}'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("http://zephyr.testserver/", response["Location"])
        self.assertIn("somesid", response["Location"])

    def test_create_google_meet_sid_error(self) -> None:
        response = self.client_get(
            "/calls/google_meet/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":"bad"}'},
        )
        self.assert_json_error(response, "Invalid Google Meet session identifier")

    @responses.activate
    def test_create_google_meet_credential_error(self) -> None:
        responses.add(
            responses.POST,
            "https://googletoken.example.com/token",
            status=400,
        )

        response = self.client_get(
            "/calls/google_meet/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assert_json_error(response, "Invalid Google Meet credentials")

    @responses.activate
    def test_create_google_meet_refresh_error(self) -> None:
        responses.add(
            responses.POST,
            "https://googletoken.example.com/token",
            json={"access_token": "token", "expires_in": -60},
        )

        response = self.client_get(
            "/calls/google_meet/complete",
            {"code": "code", "state": '{"realm":"zulip","sid":""}'},
        )
        self.assertEqual(response.status_code, 200)

        responses.replace(
            responses.POST,
            "https://googletoken.example.com/token",
            status=400,
        )

        response = self.client_post("/json/calls/google_meet/create")
        self.assert_json_error(response, "Invalid Google Meet access token")


class LiveKitVideoCallTest(ZulipTestCase):
    # The claims of a JWT are arbitrary JSON.
    def get_livekit_token(self, response: "TestHttpResponse") -> dict[str, Any]:
        self.assertEqual(response.status_code, 200)
        page_params = self._get_page_params(response)
        self.assertEqual(page_params["page_type"], "livekit_call")
        self.assertEqual(page_params["livekit_url"], "wss://livekit.example.com")
        return jwt.decode(
            page_params["livekit_token"],
            "test-api-secret-that-is-at-least-32-bytes",
            algorithms=["HS256"],
        )

    def test_join_livekit_call(self) -> None:
        hamlet = self.example_user("hamlet")
        self.login_user(hamlet)
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        # The token is decoded at the same time it was issued, since
        # decoding checks that it has not expired.
        with time_machine.travel(now, tick=False):
            response = self.client_get("/calls/livekit/join", {"call_id": "123"})
            livekit_token = self.get_livekit_token(response)
        self.assertFalse(self._get_page_params(response)["voice_only"])
        self.assertTrue(self._get_page_params(response)["remote_control_enabled"])
        self.assertEqual(
            livekit_token,
            {
                "iss": "test-api-key",
                "sub": str(hamlet.id),
                "name": "King Hamlet",
                "nbf": int(now.timestamp()),
                "exp": int(now.timestamp()) + LIVEKIT_TOKEN_LIFETIME_SECONDS,
                "video": {
                    "room": f"{hamlet.realm.uuid}-123",
                    "roomJoin": True,
                    "canPublish": True,
                    "canPublishData": True,
                    "canSubscribe": True,
                },
            },
        )

        response = self.client_get("/calls/livekit/join", {"call_id": "123", "voice_only": "true"})
        self.assertTrue(self._get_page_params(response)["voice_only"])

    def test_join_livekit_call_remote_control_disabled(self) -> None:
        hamlet = self.example_user("hamlet")
        do_set_realm_property(
            hamlet.realm, "enable_livekit_remote_control", False, acting_user=None
        )
        self.login_user(hamlet)
        response = self.client_get("/calls/livekit/join", {"call_id": "123"})
        self.assertFalse(self._get_page_params(response)["remote_control_enabled"])

    def test_join_livekit_call_from_another_realm(self) -> None:
        self.login("hamlet")
        response = self.client_get("/calls/livekit/join", {"call_id": "123"})
        zulip_token = self.get_livekit_token(response)

        sipbtest = self.mit_user("sipbtest")
        self.login_user(sipbtest)
        response = self.client_get("/calls/livekit/join", {"call_id": "123"}, subdomain="zephyr")
        zephyr_token = self.get_livekit_token(response)

        self.assertEqual(
            zephyr_token["video"], {**zulip_token["video"], "room": f"{sipbtest.realm.uuid}-123"}
        )
        self.assertNotEqual(zulip_token["video"], zephyr_token["video"])

    def test_join_livekit_call_invalid_call_id(self) -> None:
        self.login("hamlet")
        response = self.client_get("/calls/livekit/join", {"call_id": "abc"})
        self.assert_json_error(response, "call_id is not valid JSON")

        response = self.client_get("/calls/livekit/join", {"call_id": "-1"})
        self.assert_json_error(response, "call_id is too small")

    def test_join_livekit_call_not_configured(self) -> None:
        self.login("hamlet")
        with self.settings(LIVEKIT_URL=None):
            response = self.client_get("/calls/livekit/join", {"call_id": "123"})
        self.assert_json_error(response, "LiveKit credentials have not been configured")

    def join_livekit_call(self, user: UserProfile, **params: str) -> "TestHttpResponse":
        self.login_user(user)
        return self.client_get("/calls/livekit/join", {"call_id": "123", **params})

    def assert_livekit_call_access_denied(self, response: "TestHttpResponse") -> None:
        self.assertEqual(response.status_code, 403)
        self.assert_in_response("No access to this call", response)
        self.assertNotIn("livekit_token", response.content.decode())

    def test_join_livekit_direct_message_call(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        user_ids = sorted([hamlet.id, cordelia.id])
        room = f"{hamlet.realm.uuid}-dm-{user_ids[0]},{user_ids[1]}-123"

        # The room doesn't depend on how the link lists the users.
        dm = f"{cordelia.id},{hamlet.id},{cordelia.id}"
        for user in [hamlet, cordelia]:
            response = self.join_livekit_call(user, dm=dm)
            self.assertEqual(self.get_livekit_token(response)["video"]["room"], room)

        response = self.join_livekit_call(self.example_user("othello"), dm=dm)
        self.assert_livekit_call_access_denied(response)

    def test_join_livekit_channel_call(self) -> None:
        hamlet = self.example_user("hamlet")
        public_channel = self.make_stream("standup")
        response = self.join_livekit_call(hamlet, channel_id=str(public_channel.id))
        self.assertEqual(
            self.get_livekit_token(response)["video"]["room"],
            f"{hamlet.realm.uuid}-channel-{public_channel.id}-123",
        )

        polonius = self.example_user("polonius")
        response = self.join_livekit_call(polonius, channel_id=str(public_channel.id))
        self.assert_livekit_call_access_denied(response)

        private_channel = self.make_stream("secret", invite_only=True)
        self.subscribe(hamlet, "secret")
        response = self.join_livekit_call(hamlet, channel_id=str(private_channel.id))
        self.assertEqual(
            self.get_livekit_token(response)["video"]["room"],
            f"{hamlet.realm.uuid}-channel-{private_channel.id}-123",
        )

        othello = self.example_user("othello")
        response = self.join_livekit_call(othello, channel_id=str(private_channel.id))
        self.assert_livekit_call_access_denied(response)

        response = self.join_livekit_call(hamlet, channel_id="9999")
        self.assert_livekit_call_access_denied(response)

    def test_join_livekit_call_invalid_conversation(self) -> None:
        hamlet = self.example_user("hamlet")
        for dm in ["", "abc", f"{hamlet.id},", "12345678901"]:
            response = self.join_livekit_call(hamlet, dm=dm)
            self.assert_json_error(response, "dm has invalid format")

        response = self.join_livekit_call(hamlet, channel_id="abc")
        self.assert_json_error(response, "channel_id is not valid JSON")

    def test_join_livekit_call_logged_out(self) -> None:
        response = self.client_get("/calls/livekit/join", {"call_id": "123"})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("/login/"))

    def set_livekit_call_provider(self) -> None:
        do_set_realm_property(
            get_realm("zulip"),
            "video_chat_provider",
            Realm.VIDEO_CHAT_PROVIDERS["livekit"]["id"],
            acting_user=None,
        )

    def start_direct_message_call(
        self, caller: UserProfile, recipients: list[UserProfile], **params: str
    ) -> tuple[int, list[Mapping[str, Any]]]:
        self.login_user(caller)
        with self.capture_send_event_calls(expected_num_events=2) as events:
            result = self.client_post(
                "/json/calls/livekit/start",
                {
                    "type": "direct",
                    "to": orjson.dumps([user.id for user in recipients]).decode(),
                    "call_id": "123",
                    **params,
                },
            )
        message_id = self.assert_json_success(result)["message_id"]
        return message_id, [event for event in events if event["event"]["type"] == "call"]

    def test_start_livekit_call_in_direct_messages(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        iago = self.example_user("iago")
        bot = self.example_user("default_bot")
        self.set_livekit_call_provider()
        do_mute_user(iago, hamlet)

        message_id, call_events = self.start_direct_message_call(hamlet, [cordelia, iago, bot])

        user_ids = sorted([hamlet.id, cordelia.id, iago.id, bot.id])
        dm = ",".join(str(user_id) for user_id in user_ids)
        url = f"/calls/livekit/join?call_id=123&dm={dm}"
        message = self.get_last_message()
        self.assertEqual(message.id, message_id)
        self.assertEqual(message.sender_id, hamlet.id)
        self.assertEqual(message.content, f"[Join video call.]({url})")
        call = LiveKitCall.objects.get(message_id=message_id)
        self.assertEqual(call.room, f"{hamlet.realm.uuid}-dm-{dm}-123")
        self.assertIsNone(call.date_ended)
        self.assertEqual(
            call_events,
            [
                {
                    "event": {
                        "type": "call",
                        "op": "ring",
                        "message_id": message_id,
                        "caller_id": hamlet.id,
                        "url": url,
                        "voice_only": False,
                    },
                    "users": [cordelia.id],
                }
            ],
        )

    def test_start_livekit_voice_call(self) -> None:
        self.set_livekit_call_provider()
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        _message_id, call_events = self.start_direct_message_call(
            hamlet, [cordelia], voice_only="true"
        )
        dm = ",".join(str(user_id) for user_id in sorted([hamlet.id, cordelia.id]))
        url = f"/calls/livekit/join?call_id=123&dm={dm}&voice_only=true"
        self.assertEqual(self.get_last_message().content, f"[Join voice call.]({url})")
        self.assertEqual(call_events[0]["event"]["url"], url)
        self.assertTrue(call_events[0]["event"]["voice_only"])

    def test_start_livekit_call_in_channel(self) -> None:
        self.set_livekit_call_provider()
        self.login("hamlet")
        verona = get_stream("Verona", get_realm("zulip"))
        with self.capture_send_event_calls(expected_num_events=1) as events:
            result = self.client_post(
                "/json/calls/livekit/start",
                {
                    "type": "channel",
                    "channel_id": str(verona.id),
                    "topic": "standup",
                    "call_id": "123",
                },
            )
        message_id = self.assert_json_success(result)["message_id"]
        message = self.get_last_message()
        self.assertEqual(message.id, message_id)
        self.assertEqual(message.recipient.type_id, verona.id)
        self.assertEqual(message.topic_name(), "standup")
        self.assertEqual(
            message.content,
            f"[Join video call.](/calls/livekit/join?call_id=123&channel_id={verona.id})",
        )
        self.assertEqual(events[0]["event"]["type"], "message")
        self.assertEqual(
            LiveKitCall.objects.get(message_id=message_id).room,
            f"{verona.realm.uuid}-channel-{verona.id}-123",
        )

    def test_start_livekit_call_errors(self) -> None:
        self.login("hamlet")
        cordelia_id = self.example_user("cordelia").id
        direct_call = {"type": "direct", "to": orjson.dumps([cordelia_id]).decode(), "call_id": "1"}

        result = self.client_post("/json/calls/livekit/start", direct_call)
        self.assert_json_error(result, "LiveKit is not the call provider of this organization.")

        self.set_livekit_call_provider()
        with self.settings(LIVEKIT_URL=None):
            result = self.client_post("/json/calls/livekit/start", direct_call)
        self.assert_json_error(result, "LiveKit is not the call provider of this organization.")

        result = self.client_post("/json/calls/livekit/start", {"type": "direct", "call_id": "1"})
        self.assert_json_error(result, "Missing 'to' argument")

        result = self.client_post(
            "/json/calls/livekit/start", {"type": "channel", "topic": "standup", "call_id": "1"}
        )
        self.assert_json_error(result, "Missing 'channel_id' argument")

        result = self.client_post(
            "/json/calls/livekit/start",
            {"type": "direct", "to": orjson.dumps([9999]).decode(), "call_id": "1"},
        )
        self.assert_json_error(result, "Invalid user ID 9999")

        self.assert_json_success(self.client_post("/json/calls/livekit/start", direct_call))
        result = self.client_post("/json/calls/livekit/start", direct_call)
        self.assert_json_error(result, "This call has already been started.")
        self.assertEqual(LiveKitCall.objects.count(), 1)

    def update_call_ring(self, user: UserProfile, message_id: int, op: str) -> "TestHttpResponse":
        self.login_user(user)
        return self.client_post(
            "/json/calls/livekit/ring", {"message_id": str(message_id), "op": op}
        )

    def test_update_livekit_call_ring(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        iago = self.example_user("iago")
        self.set_livekit_call_provider()
        message_id, _call_events = self.start_direct_message_call(hamlet, [cordelia, iago])

        for op in ["accept", "decline"]:
            with self.capture_send_event_calls(expected_num_events=1) as events:
                result = self.update_call_ring(cordelia, message_id, op)
            self.assert_json_success(result)
            self.assertEqual(
                events[0],
                {
                    "event": {
                        "type": "call",
                        "op": op,
                        "message_id": message_id,
                        "user_id": cordelia.id,
                    },
                    "users": [hamlet.id, cordelia.id],
                },
            )

        with self.capture_send_event_calls(expected_num_events=1) as events:
            result = self.update_call_ring(hamlet, message_id, "cancel")
        self.assert_json_success(result)
        self.assertEqual(
            events[0]["event"], {"type": "call", "op": "cancel", "message_id": message_id}
        )
        self.assertEqual(sorted(events[0]["users"]), sorted([cordelia.id, iago.id]))

    def test_update_livekit_call_ring_errors(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        self.set_livekit_call_provider()
        message_id, _call_events = self.start_direct_message_call(hamlet, [cordelia])

        result = self.update_call_ring(hamlet, message_id, "accept")
        self.assert_json_error(result, "You cannot answer your own call.")

        result = self.update_call_ring(cordelia, message_id, "cancel")
        self.assert_json_error(result, "Only the caller can cancel a call.")

        result = self.update_call_ring(self.example_user("othello"), message_id, "accept")
        self.assert_json_error(result, "Invalid message(s)")

        channel_message_id = self.send_stream_message(hamlet, "Verona")
        result = self.update_call_ring(cordelia, channel_message_id, "decline")
        self.assert_json_error(result, "Calls in channels do not ring.")

    def post_livekit_webhook(
        self,
        event: Mapping[str, object],
        *,
        api_key: str = "test-api-key",
        api_secret: str = "test-api-secret-that-is-at-least-32-bytes",
        signed_body: bytes | None = None,
    ) -> "TestHttpResponse":
        body = orjson.dumps(event)
        body_hash = b64encode(hashlib.sha256(signed_body or body).digest()).decode()
        token = jwt.encode({"iss": api_key, "sha256": body_hash}, api_secret, algorithm="HS256")
        return self.client_post(
            "/calls/livekit/webhook",
            body,
            content_type="application/webhook+json",
            headers={"Authorization": token},
        )

    def room_finished(self, room: str) -> dict[str, object]:
        return {"event": "room_finished", "room": {"name": room}}

    def test_livekit_webhook_ends_direct_message_call(self) -> None:
        hamlet = self.example_user("hamlet")
        cordelia = self.example_user("cordelia")
        self.set_livekit_call_provider()
        message_id, _call_events = self.start_direct_message_call(hamlet, [cordelia])
        call = LiveKitCall.objects.get(message_id=message_id)
        dm = ",".join(str(user_id) for user_id in sorted([hamlet.id, cordelia.id]))

        response = self.join_livekit_call(cordelia, dm=dm)
        self.assertEqual(self.get_livekit_token(response)["video"]["room"], call.room)

        with self.capture_send_event_calls(expected_num_events=0):
            result = self.post_livekit_webhook(
                {"event": "participant_left", "room": {"name": call.room}}
            )
        self.assert_json_success(result)
        call.refresh_from_db()
        self.assertIsNone(call.date_ended)

        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        with (
            time_machine.travel(now, tick=False),
            self.capture_send_event_calls(expected_num_events=1) as events,
        ):
            result = self.post_livekit_webhook(self.room_finished(call.room))
        self.assert_json_success(result)
        call.refresh_from_db()
        self.assertEqual(call.date_ended, now)
        self.assertEqual(
            events[0]["event"], {"type": "call", "op": "cancel", "message_id": message_id}
        )
        self.assertEqual(sorted(events[0]["users"]), sorted([hamlet.id, cordelia.id]))

        # LiveKit can send an event more than once.
        with self.capture_send_event_calls(expected_num_events=0):
            result = self.post_livekit_webhook(self.room_finished(call.room))
        self.assert_json_success(result)
        call.refresh_from_db()
        self.assertEqual(call.date_ended, now)

        response = self.join_livekit_call(cordelia, dm=dm)
        self.assertEqual(response.status_code, 200)
        self.assert_in_response("This call has ended", response)
        self.assert_in_response(
            f'href="{hamlet.realm.url}/#narrow/dm/{dm}/with/{message_id}"', response
        )
        self.assertNotIn("livekit_token", response.content.decode())

    def test_livekit_webhook_ends_channel_call(self) -> None:
        hamlet = self.example_user("hamlet")
        verona = get_stream("Verona", hamlet.realm)
        self.set_livekit_call_provider()
        self.login_user(hamlet)
        result = self.client_post(
            "/json/calls/livekit/start",
            {"type": "channel", "channel_id": str(verona.id), "topic": "standup", "call_id": "123"},
        )
        message_id = self.assert_json_success(result)["message_id"]
        call = LiveKitCall.objects.get(message_id=message_id)

        # Calls in channels don't ring, so there is nothing to cancel.
        with self.capture_send_event_calls(expected_num_events=0):
            result = self.post_livekit_webhook(self.room_finished(call.room))
        self.assert_json_success(result)
        call.refresh_from_db()
        self.assertIsNotNone(call.date_ended)

        response = self.join_livekit_call(hamlet, channel_id=str(verona.id))
        self.assert_in_response("This call has ended", response)
        self.assert_in_response(
            f'href="{hamlet.realm.url}/#narrow/channel/{verona.id}/topic/standup/with/{message_id}"',
            response,
        )

    def test_livekit_webhook_unknown_room(self) -> None:
        # Other Zulip servers can share the LiveKit server.
        with self.capture_send_event_calls(expected_num_events=0):
            result = self.post_livekit_webhook(self.room_finished("another-server-room"))
        self.assert_json_success(result)

    def test_livekit_webhook_invalid_signature(self) -> None:
        event = self.room_finished("room")
        for response in [
            self.post_livekit_webhook(event, api_secret="another-secret-that-is-at-least-32-bytes"),
            self.post_livekit_webhook(event, api_key="another-api-key"),
            self.post_livekit_webhook(event, signed_body=b"{}"),
            self.client_post(
                "/calls/livekit/webhook",
                orjson.dumps(event),
                content_type="application/webhook+json",
            ),
        ]:
            self.assert_json_error(response, "Invalid LiveKit webhook signature", status_code=401)

        with self.settings(LIVEKIT_API_SECRET=None):
            response = self.post_livekit_webhook(event)
        self.assert_json_error(response, "LiveKit credentials have not been configured")
