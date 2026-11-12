* [`GET /streams`](/api/get-streams),
  [`GET /users/me/subscriptions`](/api/get-subscriptions),
  [`POST /register`](/api/register-queue),
  [`GET /events`](/api/get-events): The `name` of a channel in a channel
  folder is now the name of the folder, a `/`, and the name chosen for
  the channel. Channels in different channel folders can have the same
  name after the `/`.
* [`POST /channels/create`](/api/create-channel),
  [`POST /users/me/subscriptions`](/api/subscribe): A channel created
  with `folder_id` is now named after the channel folder. The name in
  the request can be given with or without the name of the folder.
* [`PATCH /streams/{stream_id}`](/api/update-stream): Changing
  `folder_id` now renames the channel, and fails if another channel has
  the name that the channel would get. The `new_name` of a channel in a
  channel folder can be given with or without the name of the folder.
* [`PATCH /channel_folders/{channel_folder_id}`](/api/update-channel-folder):
  Changing `name` now renames the channels in the channel folder, and
  fails if another channel has the name that one of them would get.
* [`POST /register`](/api/register-queue): `max_stream_name_length` is
  now the maximum length of the name chosen for a channel. The `name`
  of a channel in a channel folder is longer by the name of the folder
  and a `/`.
