from django.db import models

from zerver.models.messages import Message


class LiveKitCall(models.Model):
    """A LiveKit call started in a conversation, which we track so that
    its link stops working once the call has ended."""

    # The name of the call's LiveKit room, which is unique across
    # organizations; see get_livekit_call_room.
    room = models.TextField(unique=True)
    # The message with the link to the call.
    message = models.ForeignKey(Message, on_delete=models.CASCADE)
    # When LiveKit closed the room, after the last participant left.
    date_ended = models.DateTimeField(null=True)
