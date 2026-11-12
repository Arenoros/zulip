* [`POST /channel_folders/create`](/api/create-channel-folder): Any user
  other than a guest can now create channel folders, and becomes the
  administrator of the folder they create. Previously, only organization
  administrators could create channel folders.
* [`PATCH /channel_folders/{channel_folder_id}`](/api/update-channel-folder):
  Added `can_administer_group` parameter to change who can administer a
  channel folder. Users with that permission can now update the folder,
  in addition to organization administrators.
* [`GET /channel_folders`](/api/get-channel-folders),
  [`POST /register`](/api/register-queue),
  [`GET /events`](/api/get-events): Added `can_administer_group` field to
  channel folder objects, and to the data of `channel_folder` events with
  `op: "update"`.
* [`POST /register`](/api/register-queue): Added `channel_folder` field to
  the `server_supported_permission_settings` object.
* [`POST /user_groups/{user_group_id}/deactivate`](/api/deactivate-user-group):
  The `objections` in the error for a user group in use can now have
  the `channel_folder` type.
