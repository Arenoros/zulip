* [`POST /channel_folders/create`](/api/create-channel-folder),
  [`PATCH /channel_folders/{channel_folder_id}`](/api/update-channel-folder):
  Added `can_access_group` parameter to choose who can see a channel
  folder and the channels in it. A channel folder with web-public or
  default channels cannot be made private.
* [`GET /channel_folders`](/api/get-channel-folders),
  [`POST /register`](/api/register-queue),
  [`GET /events`](/api/get-events): Added `can_access_group` field to
  channel folder objects, and to the data of `channel_folder` events
  with `op: "update"`. Users only receive the channel folders they can
  see, which are those whose `can_access_group` includes them, and
  those they administer.
* [`GET /events`](/api/get-events): Added `channel_folder` events with
  `op: "remove"`, sent to users who can no longer see a channel folder.
  Users who become able to see a channel folder receive a
  `channel_folder` event with `op: "add"`. The `order` in
  `channel_folder` events with `op: "reorder"` now only contains the
  channel folders the user can see.
* [`POST /register`](/api/register-queue): Added `can_access_group` to
  the `channel_folder` object in `server_supported_permission_settings`.
* [`PATCH /streams/{stream_id}`](/api/update-stream),
  [`POST /channels/create`](/api/create-channel),
  [`POST /users/me/subscriptions`](/api/subscribe),
  [`POST /default_streams`](/api/add-default-stream): Web-public
  channels and default channels cannot be in a private channel folder.
