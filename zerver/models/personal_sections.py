from django.db import models

from zerver.models.users import UserProfile


class PersonalSections(models.Model):
    """The sections a user sorted their direct message conversations
    into, in the order the user arranged them.
    """

    MAX_SECTIONS = 50
    MAX_SECTION_NAME_LENGTH = 60
    # Limits on how much a user can sort into sections, since all of
    # it is sent to each of their clients.
    MAX_ITEMS = 500
    MAX_CONVERSATION_USERS = 100

    user_profile = models.OneToOneField(UserProfile, on_delete=models.CASCADE)
    conversation_sections = models.JSONField(default=list)
