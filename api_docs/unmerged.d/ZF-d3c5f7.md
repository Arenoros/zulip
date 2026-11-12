* [`GET /events`](/api/get-events): Users who can no longer see a
  channel folder, because its `can_access_group` or
  `can_administer_group` changed, because they left a group or because
  their role changed, are unsubscribed from the channels in it. They
  receive `subscription` events with `op: "remove"` and `stream` events
  with `op: "delete"` for these channels before the `channel_folder`
  event with `op: "remove"`. Users who become able to see a channel
  folder receive the `channel_folder` event with `op: "add"` before
  `stream` events with `op: "create"` for its channels.
* [`PATCH /streams/{stream_id}`](/api/update-stream): Moving a channel
  to a private channel folder unsubscribes the users who cannot see
  that folder, and users who can no longer see the channel receive a
  `stream` event with `op: "delete"`. Users who become able to see a
  channel receive a `stream` event with `op: "create"`.
