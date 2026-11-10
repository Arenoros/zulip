---
status: accepted
---

# Validate admission to calls started from conversations

The Zulip server checks who can join an active call started from a conversation. A direct message call admits the caller, the original recipients, and users explicitly invited to it, while a channel call admits users with access to the originating topic under the usual Zulip rules. Existing standalone links and links inserted while editing a message retain the link-only flow because those links can exist without a call origin.
