---
status: accepted
---

# Require private folder access for channel history

Reading messages in a channel inside a private folder requires access to both the folder and the channel. Revoking folder access closes server access to that channel's history, including messages the user previously received. Zulip lets any non-guest member read a public channel's history without being subscribed, so message lookup and search must check folder access before applying that rule. Private channels already require a subscription or group membership to read history, and the folder rule applies in addition to it.

Losing access to a private folder unsubscribes the user from the folder's channels, and subscribing to a channel in a private folder requires folder access. Unsubscribing reuses the existing events that close a channel in every client and stops message delivery and notifications, so those paths do not each need a folder check. A user who regains folder access subscribes again. Keeping subscriptions and checking folder access on every delivery path was rejected because one missed path would leak messages.
