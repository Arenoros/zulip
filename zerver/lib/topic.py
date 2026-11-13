from collections.abc import Callable
from datetime import datetime
from typing import Any

import orjson
from django.db import connection
from django.db.models import (
    Exists,
    F,
    Func,
    JSONField,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    TextField,
    Value,
)
from django.db.models.functions import Cast
from django.utils.translation import gettext as _
from django.utils.translation import override as override_language
from psycopg2.sql import SQL, Composable

from zerver.lib.types import EditHistoryEvent, StreamMessageEditRequest
from zerver.lib.utils import assert_is_not_none
from zerver.models import Message, Reaction, UserMessage, UserProfile, UserTopic

# Only use these constants for events.
ORIG_TOPIC = "orig_subject"
TOPIC_NAME = "subject"
TOPIC_LINKS = "topic_links"
MATCH_TOPIC = "match_subject"

# Prefix use to mark topic as resolved.
RESOLVED_TOPIC_PREFIX = "✔ "

# This constant is pretty closely coupled to the
# database, but it's the JSON field.
EXPORT_TOPIC_NAME = "subject"

"""
The following functions are for user-facing APIs
where we'll want to support "subject" for a while.
"""


def get_topic_from_message_info(message_info: dict[str, Any]) -> str:
    """
    Use this where you are getting dicts that are based off of messages
    that may come from the outside world, especially from third party
    APIs and bots.

    We prefer 'topic' to 'subject' here.  We expect at least one field
    to be present (or the caller must know how to handle KeyError).
    """
    if "topic" in message_info:
        return message_info["topic"]

    return message_info["subject"]


"""
TRY TO KEEP THIS DIVIDING LINE.

Below this line we want to make it so that functions are only
using "subject" in the DB sense, and nothing customer facing.

"""

# This is used in low-level message functions in
# zerver/lib/message.py, and it's not user facing.
DB_TOPIC_NAME = "subject"
MESSAGE__TOPIC = "message__subject"


def filter_by_topic_name_via_message(
    query: QuerySet[UserMessage], topic_name: str
) -> QuerySet[UserMessage]:
    return query.filter(message__is_channel_message=True, message__subject__iexact=topic_name)


def messages_for_topic(
    realm_id: int, stream_recipient_id: int, topic_name: str
) -> QuerySet[Message]:
    return Message.objects.filter(
        # Uses index: zerver_message_realm_recipient_upper_subject
        realm_id=realm_id,
        recipient_id=stream_recipient_id,
        subject__iexact=topic_name,
        is_channel_message=True,
    )


def get_latest_message_for_user_in_topic(
    realm_id: int,
    user_profile: UserProfile | None,
    recipient_id: int,
    topic_name: str,
    history_public_to_subscribers: bool,
    acting_user_has_channel_content_access: bool = False,
) -> int | None:
    # Guard against incorrectly calling this function without
    # first checking for channel access.
    assert acting_user_has_channel_content_access

    if history_public_to_subscribers:
        return (
            messages_for_topic(realm_id, recipient_id, topic_name)
            .values_list("id", flat=True)
            .last()
        )

    elif user_profile is not None:
        return (
            UserMessage.objects.filter(
                user_profile=user_profile,
                message__recipient_id=recipient_id,
                message__subject__iexact=topic_name,
                message__is_channel_message=True,
            )
            .values_list("message_id", flat=True)
            .last()
        )

    return None


def save_message_for_edit_use_case(message: Message) -> None:
    message.save(
        update_fields=[
            TOPIC_NAME,
            "content",
            "rendered_content",
            "rendered_content_version",
            "last_edit_time",
            "edit_history",
            "has_attachment",
            "has_image",
            "has_link",
            "recipient_id",
        ]
    )


def user_message_exists_for_topic(
    user_profile: UserProfile, recipient_id: int, topic_name: str
) -> bool:
    return UserMessage.objects.filter(
        user_profile=user_profile,
        message__recipient_id=recipient_id,
        message__subject__iexact=topic_name,
        message__is_channel_message=True,
    ).exists()


def update_edit_history(
    message: Message, last_edit_time: datetime, edit_history_event: EditHistoryEvent
) -> None:
    message.last_edit_time = last_edit_time
    if message.edit_history is not None:
        edit_history: list[EditHistoryEvent] = orjson.loads(message.edit_history)
        edit_history.insert(0, edit_history_event)
    else:
        edit_history = [edit_history_event]
    message.edit_history = orjson.dumps(edit_history).decode()


def update_messages_for_topic_edit(
    acting_user: UserProfile,
    edited_message: Message,
    message_edit_request: StreamMessageEditRequest,
    edit_history_event: EditHistoryEvent,
    last_edit_time: datetime,
) -> tuple[QuerySet[Message], Callable[[], None]]:
    # Uses index: zerver_message_realm_recipient_upper_subject
    old_stream = message_edit_request.orig_stream
    messages = Message.objects.filter(
        realm_id=old_stream.realm_id,
        recipient_id=assert_is_not_none(old_stream.recipient_id),
        subject__iexact=message_edit_request.orig_topic_name,
        is_channel_message=True,
    )
    if message_edit_request.propagate_mode == "change_all":
        messages = messages.exclude(id=edited_message.id)
    if message_edit_request.propagate_mode == "change_later":
        messages = messages.filter(id__gt=edited_message.id)

    if message_edit_request.is_stream_edited:
        # If we're moving the messages between streams, only move
        # messages that the acting user can access, so that one cannot
        # gain access to messages through moving them.
        from zerver.lib.message import bulk_access_stream_messages_query

        messages = bulk_access_stream_messages_query(acting_user, messages, old_stream)
    else:
        # For single-message edits or topic moves within a stream, we
        # allow moving history the user may not have access in order
        # to keep topics together.
        pass

    update_fields: dict[str, object] = {
        "last_edit_time": last_edit_time,
        # We cast the `edit_history` column to jsonb (defaulting NULL
        # to `[]`), apply the `||` array concatenation operator to it,
        # and cast the result back to text.  See #26496 for making
        # this column itself jsonb, which is a complicated migration.
        #
        # This equates to:
        #    "edit_history" = (
        #      ( '[{ ..json event.. }]' )::jsonb
        #      ||
        #      (COALESCE("zerver_message"."edit_history", '[]'))::jsonb
        #     )::text
        "edit_history": Cast(
            Func(
                Cast(
                    Value(orjson.dumps([edit_history_event]).decode()),
                    JSONField(),
                ),
                Cast(
                    Func(
                        F("edit_history"),
                        Value("[]"),
                        function="COALESCE",
                    ),
                    JSONField(),
                ),
                function="",
                arg_joiner=" || ",
            ),
            TextField(),
        ),
    }
    if message_edit_request.is_stream_edited:
        update_fields["recipient"] = message_edit_request.target_stream.recipient
    if message_edit_request.is_topic_edited:
        update_fields["subject"] = message_edit_request.target_topic_name

    def propagate() -> None:
        messages.update(**update_fields)

    return messages, propagate


def generate_topic_history_from_db_rows(
    rows: list[tuple[str, int]],
    allow_empty_topic_name: bool,
) -> list[dict[str, Any]]:
    canonical_topic_names: dict[str, tuple[int, str]] = {}

    # Sort rows by max_message_id so that if a topic
    # has many different casings, we use the most
    # recent row.
    rows = sorted(rows, key=lambda tup: tup[1])

    for topic_name, max_message_id in rows:
        canonical_name = topic_name.lower()
        canonical_topic_names[canonical_name] = (max_message_id, topic_name)

    history = []
    for max_message_id, topic_name in canonical_topic_names.values():
        if topic_name == "" and not allow_empty_topic_name:
            topic_name = Message.EMPTY_TOPIC_FALLBACK_NAME
        history.append(
            dict(name=topic_name, max_id=max_message_id),
        )
    return sorted(history, key=lambda x: -x["max_id"])


def get_topic_history_for_public_stream(
    realm_id: int,
    recipient_id: int,
    allow_empty_topic_name: bool,
) -> list[dict[str, Any]]:
    cursor = connection.cursor()
    # Uses index: zerver_message_realm_recipient_subject
    # Note that this is *case-sensitive*, so that we can display the
    # most recently-used case (in generate_topic_history_from_db_rows)
    query = """
    SELECT
        "zerver_message"."subject" as topic,
        max("zerver_message".id) as max_message_id
    FROM "zerver_message"
    WHERE (
        "zerver_message"."realm_id" = %s AND
        "zerver_message"."recipient_id" = %s AND
        "zerver_message"."is_channel_message"
    )
    GROUP BY (
        "zerver_message"."subject"
    )
    ORDER BY max("zerver_message".id) DESC
    """
    cursor.execute(query, [realm_id, recipient_id])
    rows = cursor.fetchall()
    cursor.close()

    return generate_topic_history_from_db_rows(rows, allow_empty_topic_name)


def get_topic_history_for_stream(
    user_profile: UserProfile,
    recipient_id: int,
    public_history: bool,
    allow_empty_topic_name: bool,
) -> list[dict[str, Any]]:
    if public_history:
        return get_topic_history_for_public_stream(
            user_profile.realm_id,
            recipient_id,
            allow_empty_topic_name,
        )

    cursor = connection.cursor()
    # Uses index: zerver_message_realm_recipient_subject
    # Note that this is *case-sensitive*, so that we can display the
    # most recently-used case (in generate_topic_history_from_db_rows)
    query = """
    SELECT
        "zerver_message"."subject" as topic,
        max("zerver_message".id) as max_message_id
    FROM "zerver_message"
    INNER JOIN "zerver_usermessage" ON (
        "zerver_usermessage"."message_id" = "zerver_message"."id"
    )
    WHERE (
        "zerver_usermessage"."user_profile_id" = %s AND
        "zerver_message"."realm_id" = %s AND
        "zerver_message"."recipient_id" = %s AND
        "zerver_message"."is_channel_message"
    )
    GROUP BY (
        "zerver_message"."subject"
    )
    ORDER BY max("zerver_message".id) DESC
    """
    cursor.execute(query, [user_profile.id, user_profile.realm_id, recipient_id])
    rows = cursor.fetchall()
    cursor.close()

    return generate_topic_history_from_db_rows(rows, allow_empty_topic_name)


# A topic card shows up to this many of the most recent authors of
# the replies it leaves out.
MAX_HIDDEN_REPLY_SENDERS_PER_TOPIC_CARD = 3


def get_topic_cards(
    *,
    realm_id: int,
    recipient_id: int,
    user_profile: UserProfile | None,
    public_history: bool,
    first_visible_message_id: int,
    anchor: int | None,
    num_topics: int,
    num_replies: int,
    allow_empty_topic_name: bool,
) -> tuple[list[dict[str, Any]], list[int], bool]:
    """Returns the topic cards for a page of a channel's topics, the
    topic with the most recent message first; the IDs of the messages
    the cards show, which are each topic's first message and its
    latest replies; and whether there are no older topics.

    Only messages the user can access count, so in a channel with
    protected history, a topic's first message is the earliest one
    the user received. Topic names are compared case-insensitively,
    and a card uses the most recent spelling.
    """
    if public_history:
        message_source: Composable = SQL("zerver_message AS m")
    else:
        assert user_profile is not None
        message_source = SQL(
            """
            zerver_message AS m
            JOIN zerver_usermessage AS um ON (
                um.message_id = m.id AND um.user_profile_id = %(user_profile_id)s
            )
            """
        )
    anchor_condition = SQL("HAVING max(m.id) < %(anchor)s") if anchor is not None else SQL("")
    params = dict(
        realm_id=realm_id,
        recipient_id=recipient_id,
        user_profile_id=None if user_profile is None else user_profile.id,
        first_visible_message_id=first_visible_message_id,
        anchor=anchor,
        # One extra topic tells us whether older topics exist.
        limit=num_topics + 1,
        num_replies=num_replies,
    )

    # Finds each topic's latest message by grouping, which is much
    # faster than sorting the channel's messages, and then reads the
    # topic's most recent spelling from that message.
    topics_query = SQL(
        """
        SELECT upper(latest.subject), latest.subject, latest.id
        FROM (
            SELECT max(m.id) AS max_id
            FROM {message_source}
            WHERE m.realm_id = %(realm_id)s
                AND m.recipient_id = %(recipient_id)s
                AND m.is_channel_message
                AND m.id >= %(first_visible_message_id)s
            GROUP BY upper(m.subject)
            {anchor_condition}
            ORDER BY max_id DESC
            LIMIT %(limit)s
        ) AS latest_message_per_topic
        JOIN zerver_message AS latest ON latest.id = latest_message_per_topic.max_id
        ORDER BY latest.id DESC
        """
    ).format(message_source=message_source, anchor_condition=anchor_condition)

    # For the chosen topics, returns the messages a card shows, with
    # the topic's first message and size, and then each author of the
    # replies the card leaves out, with their latest such reply.
    details_query = SQL(
        """
        WITH topic_messages AS (
            SELECT
                m.id,
                m.sender_id,
                upper(m.subject) AS topic_key,
                row_number() OVER (PARTITION BY upper(m.subject) ORDER BY m.id DESC) AS recency,
                min(m.id) OVER (PARTITION BY upper(m.subject)) AS first_id,
                count(*) OVER (PARTITION BY upper(m.subject)) AS message_count
            FROM {message_source}
            WHERE m.realm_id = %(realm_id)s
                AND m.recipient_id = %(recipient_id)s
                AND m.is_channel_message
                AND m.id >= %(first_visible_message_id)s
                AND upper(m.subject) = ANY(%(topic_keys)s)
        )
        SELECT TRUE AS is_shown, topic_key, id, first_id, message_count, NULL AS sender_id
        FROM topic_messages
        WHERE recency <= %(num_replies)s OR id = first_id
        UNION ALL
        SELECT FALSE AS is_shown, topic_key, max(id), NULL, NULL, sender_id
        FROM topic_messages
        WHERE recency > %(num_replies)s AND id != first_id
        GROUP BY topic_key, sender_id
        """
    ).format(message_source=message_source)

    with connection.cursor() as cursor:
        cursor.execute(topics_query, params)
        topic_rows = cursor.fetchall()
        found_oldest = len(topic_rows) <= num_topics
        topic_rows = topic_rows[:num_topics]
        if not topic_rows:
            return [], [], found_oldest

        cards: dict[str, dict[str, Any]] = {}
        for topic_key, topic_name, max_id in topic_rows:
            if topic_name == "" and not allow_empty_topic_name:
                topic_name = Message.EMPTY_TOPIC_FALLBACK_NAME
            cards[topic_key] = dict(
                topic_name=topic_name,
                max_id=max_id,
                hidden_reply_sender_ids=[],
                hidden_reply_sender_count=0,
            )

        cursor.execute(details_query, {**params, "topic_keys": list(cards)})
        detail_rows = cursor.fetchall()

    shown_message_ids: list[int] = []
    hidden_reply_senders: dict[str, list[tuple[int, int]]] = {}
    for is_shown, topic_key, message_id, first_id, message_count, sender_id in detail_rows:
        if is_shown:
            shown_message_ids.append(message_id)
            cards[topic_key]["first_message_id"] = first_id
            cards[topic_key]["reply_count"] = message_count - 1
        else:
            hidden_reply_senders.setdefault(topic_key, []).append((message_id, sender_id))

    for topic_key, senders in hidden_reply_senders.items():
        senders.sort(reverse=True)
        cards[topic_key]["hidden_reply_sender_ids"] = [
            sender_id for _, sender_id in senders[:MAX_HIDDEN_REPLY_SENDERS_PER_TOPIC_CARD]
        ]
        cards[topic_key]["hidden_reply_sender_count"] = len(senders)

    return list(cards.values()), sorted(shown_message_ids), found_oldest


def get_topic_resolution_and_bare_name(stored_name: str) -> tuple[bool, str]:
    """
    Resolved topics are denoted only by a title change, not by a boolean toggle in a database column. This
    method inspects the topic name and returns a tuple of:

    - Whether the topic has been resolved
    - The topic name with the resolution prefix, if present in stored_name, removed
    """
    if stored_name.startswith(RESOLVED_TOPIC_PREFIX):
        return (True, stored_name.removeprefix(RESOLVED_TOPIC_PREFIX))

    return (False, stored_name)


def participants_for_topic(realm_id: int, recipient_id: int, topic_name: str) -> set[int]:
    """
    Users who either sent or reacted to the messages in the topic.
    The function is expensive for large numbers of messages in the topic.
    """
    messages = Message.objects.filter(
        # Uses index: zerver_message_realm_recipient_upper_subject
        realm_id=realm_id,
        recipient_id=recipient_id,
        subject__iexact=topic_name,
        is_channel_message=True,
    )
    participants = set(
        UserProfile.objects.filter(
            Q(id__in=Subquery(messages.values("sender_id")))
            | Q(
                id__in=Subquery(
                    Reaction.objects.filter(message__in=messages).values("user_profile_id")
                )
            )
        ).values_list("id", flat=True)
    )
    return participants


def maybe_rename_general_chat_to_empty_topic(topic_name: str) -> str:
    if topic_name == Message.EMPTY_TOPIC_FALLBACK_NAME:
        topic_name = ""
    return topic_name


def maybe_rename_no_topic_to_empty_topic(topic_name: str) -> str:
    if topic_name == "(no topic)":
        topic_name = ""
    return topic_name


def maybe_rename_empty_topic_to_general_chat(
    topic_name: str, is_channel_message: bool, allow_empty_topic_name: bool
) -> str:
    if is_channel_message and topic_name == "" and not allow_empty_topic_name:
        return Message.EMPTY_TOPIC_FALLBACK_NAME
    return topic_name


def get_topic_display_name(topic_name: str, language: str) -> str:
    if topic_name == "":
        with override_language(language):
            return _(Message.EMPTY_TOPIC_FALLBACK_NAME)
    return topic_name


def topic_match_q(topic_name: str) -> Q:
    return Q(subject__iexact=topic_name, is_channel_message=True)


def get_resolved_topic_condition_q() -> Q:
    return Q(subject__startswith=RESOLVED_TOPIC_PREFIX, is_channel_message=True)


def matching_user_topic_exists_q(topics: QuerySet[UserTopic]) -> Q:
    """Matches the messages that one of the given UserTopic rows is for.

    Correlating against zerver_usertopic, rather than inlining a
    condition per row, keeps the query a fixed size however many rows
    there are.

    Matching a UserTopic's recipient already implies the message is a
    channel message, since a UserTopic's recipient is always its
    channel's, so is_channel_message is not tested here.
    """
    return Q(
        Exists(
            topics.filter(
                recipient_id=OuterRef("recipient_id"),
                topic_name__iexact=OuterRef(DB_TOPIC_NAME),
            )
        )
    )


def get_followed_topic_condition_q(user_id: int) -> Q:
    return matching_user_topic_exists_q(
        UserTopic.objects.filter(
            user_profile_id=user_id,
            visibility_policy=UserTopic.VisibilityPolicy.FOLLOWED,
        )
    )
