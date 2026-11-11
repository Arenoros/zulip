---
status: accepted
---

# Qualify channel names by folder

Channels in folders have organization-wide names in the form `<folder>/<channel>`. The qualified name allows different folders to contain channels with the same short name while providing an unambiguous name for each channel.

The qualified name is stored as the channel's name, and the short name is derived by removing the folder prefix. Channel names therefore stay unique within the organization, so the API, existing clients, and lookups by name keep working unchanged. In exchange, moving a channel or renaming a folder renames the affected channels, the channel name limit grows to fit a folder name, a slash, and a short name, and new folder names and short names cannot contain a slash. Storing only the short name and making it unique per folder was rejected because every client and integration assumes a channel name identifies one channel in the organization.
