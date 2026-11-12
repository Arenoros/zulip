---
status: accepted
---

# Generate initials avatars on the server

Initials avatars are a third source of default profile pictures, next to Jdenticon and Gravatar. The server draws the picture and stores it like an uploaded one, so the web app, the mobile app, emails and notifications all show the same initials without each client implementing them. The server already stores a generated Jdenticon at the same URL as an uploaded photo, so a client cannot tell a default picture from a real one; drawing initials in the web app would have required exposing the avatar source in the API and repeating the drawing in every other client. The cost is that the picture depends on the user's name: renaming a user redraws it, and the letters keep one proportion of the circle at every size.
