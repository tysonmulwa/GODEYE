"""Which failures are the channel's fault, and which are the post's.

Every permanent publish failure used to be stamped onto the connection, so a
post rejected for having no image put a red line on a healthy Instagram
account. It stayed there until a later post happened to succeed, or the user
disconnected and reconnected, which is what they ended up doing.
"""

from godeye_engine.tasks.scheduler import _is_connection_fault


class TestPostFaults:
    """These describe one post. The channel is fine and must stay clean."""

    def test_missing_media(self):
        assert not _is_connection_fault("Instagram requires an image or video, attach one")

    def test_caption_too_long(self):
        assert not _is_connection_fault("Caption exceeds the 2200 character limit")

    def test_unsupported_aspect_ratio(self):
        assert not _is_connection_fault("Video aspect ratio must be between 0.01 and 10")

    def test_rate_limited(self):
        # Temporary and nothing the user can fix by reconnecting.
        assert not _is_connection_fault("Application request limit reached")

    def test_compliance_refusal(self):
        assert not _is_connection_fault("Price comparison not allowed in this market")


class TestConnectionFaults:
    """These mean reconnect. They belong on the card, and flip it out of ACTIVE."""

    def test_expired_token(self):
        assert _is_connection_fault("Error validating access token: Session has expired")

    def test_revoked(self):
        assert _is_connection_fault("The user has revoked this app's permissions")

    def test_missing_permission(self):
        assert _is_connection_fault("(#200) Requires pages_manage_posts permission")

    def test_unauthorized(self):
        assert _is_connection_fault("401 Unauthorized")

    def test_undecryptable_credentials(self):
        # The message _publish raises when TOKEN_ENCRYPTION_KEY does not match.
        assert _is_connection_fault(
            "Could not decrypt the stored credentials for this connection. "
            "Reconnect the account, it was connected with a different "
            "TOKEN_ENCRYPTION_KEY than this server uses."
        )

    def test_case_is_ignored(self):
        assert _is_connection_fault("OAuthException: Invalid OAuth access token")
