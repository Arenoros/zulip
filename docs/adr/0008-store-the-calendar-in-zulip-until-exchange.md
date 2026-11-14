---
status: accepted
---

# Store the calendar in Zulip until Exchange takes over

The calendar is stored in Zulip's database, including in production, because getting access to a test Exchange server takes too long to wait for. Exchange is meant to become the only source of truth later, through EWS, so the stored data follows Exchange's calendar items: each event has an iCalendar UID, a series has an RRULE with changed and cancelled occurrences, and each attendee has their own response, reminder and category, like the copy of a meeting in each mailbox. The rest of Zulip reads and changes the calendar only through `zerver/lib/calendar/`, so replacing the storage changes that module and not its callers. The cost is a migration when Exchange takes over: future meetings have to be created in Exchange with the same UIDs, and anything Exchange cannot represent, such as a repetition rule it does not support, has to be refused when the event is saved rather than discovered then.
