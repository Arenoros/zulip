from django.db import models

from zerver.models.messages import Message
from zerver.models.users import UserProfile


class LiveKitCall(models.Model):
    """A LiveKit call started in a conversation, which we track so that
    its link stops working once the call has ended, and so that people
    can be called to join it."""

    # The name of the call's LiveKit room, which is unique across
    # organizations; see get_livekit_call_room.
    room = models.TextField(unique=True)
    # The message with the link to the call.
    message = models.ForeignKey(Message, on_delete=models.CASCADE)
    # The link to the call, and whether it is a voice call, for ringing
    # the people called to join it.
    url = models.TextField(default="")
    voice_only = models.BooleanField(default=False)
    # When LiveKit closed the room, after the last participant left.
    date_ended = models.DateTimeField(null=True)


class LiveKitCallParticipant(models.Model):
    """Someone who joined a LiveKit call, per LiveKit's webhooks."""

    call = models.ForeignKey(LiveKitCall, on_delete=models.CASCADE)
    user_profile = models.ForeignKey(UserProfile, on_delete=models.CASCADE)
    # Whether they are in the call now.
    in_call = models.BooleanField(default=True)

    class Meta:
        unique_together = ("call", "user_profile")


class LiveKitCallRing(models.Model):
    """A user being called to join a LiveKit call, by the caller of a
    direct message call or by someone in the call who invited them."""

    call = models.ForeignKey(LiveKitCall, on_delete=models.CASCADE)
    user_profile = models.ForeignKey(UserProfile, on_delete=models.CASCADE)
    caller = models.ForeignKey(UserProfile, on_delete=models.CASCADE, related_name="+")
    # The message with the link to the call in the conversation where
    # the user can find the call: the call's message, or for someone
    # invited to a direct message call, the message inviting them to
    # the group direct message of everyone called to it.
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name="+")
    date_rang = models.DateTimeField()

    ACCEPTED = 1
    DECLINED = 2
    CANCELLED = 3
    # How the ringing stopped, unless it timed out or is still going on.
    answer = models.PositiveSmallIntegerField(null=True)
