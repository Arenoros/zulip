* [`POST /register`](/api/register-queue), [`GET /streams`](/api/get-streams),
  [`GET /streams/{stream_id}`](/api/get-stream-by-id),
  [`GET /messages`](/api/get-messages),
  [`GET /messages/{message_id}`](/api/get-message): A channel in a private
  channel folder, its messages and its subscribers are only available
  to users who can see the channel folder, in addition to the
  permissions of the channel itself. This includes searches of all
  public channels.
* [`POST /users/me/subscriptions`](/api/subscribe),
  [`POST /channels/create`](/api/create-channel): Users who cannot see
  the channel folder of a channel cannot be subscribed to it. Channel
  folders a user cannot see are reported as invalid, like those that do
  not exist.
* [`GET /events`](/api/get-events): Events about a channel in a private
  channel folder, and about its subscribers, are only sent to users who
  can see the channel folder.
