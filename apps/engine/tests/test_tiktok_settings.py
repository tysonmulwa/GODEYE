"""TikTok's Content Sharing Guidelines, from the publisher's side.

The app was rejected because it chose the privacy level itself, server-side, at
publish time -- reading ``creator_info`` and taking the most public option the
account allowed. The guidelines' "Required UX Implementation in Your App"
requires three things to be the *creator's* decisions, made in our UI:

  2. Privacy level, from the options their own account offers, with nothing
     pre-selected.
  3. Interaction settings: comment, duet, stitch.
  4. Content disclosure: their own brand, a third party's, or neither.

These tests pin the half of that which lives here -- that a creator's choice
travels intact to TikTok, and that the absence of one is never filled in on
their behalf. The UI half is pinned in apps/web.
"""

from __future__ import annotations

import pytest

from godeye_engine.publishers.base import TikTokPostSettings


class TestReadingWhatTheComposerStored:
    """The JSON column is written by the API and read here. A field lost in
    translation is a creator's choice silently replaced by a default."""

    FULL = {
        "privacyLevel": "MUTUAL_FOLLOW_FRIENDS",
        "disableComment": True,
        "disableDuet": True,
        "disableStitch": True,
        "brandOrganic": True,
        "brandedContent": True,
    }

    def test_reads_every_field(self):
        settings = TikTokPostSettings.from_json(self.FULL)
        assert settings.privacy_level == "MUTUAL_FOLLOW_FRIENDS"
        assert settings.disable_comment is True
        assert settings.disable_duet is True
        assert settings.disable_stitch is True
        assert settings.brand_organic is True
        assert settings.branded_content is True

    def test_defaults_every_toggle_to_off(self):
        """Only the privacy level is required. An interaction the creator did
        not disable stays enabled, which is TikTok's own default and not an
        assumption about what they wanted."""
        settings = TikTokPostSettings.from_json({"privacyLevel": "SELF_ONLY"})
        assert settings.privacy_level == "SELF_ONLY"
        assert not any(
            [
                settings.disable_comment,
                settings.disable_duet,
                settings.disable_stitch,
                settings.brand_organic,
                settings.branded_content,
            ]
        )

    @pytest.mark.parametrize(
        "raw",
        [
            None,
            {},
            {"privacyLevel": ""},
            {"privacyLevel": None},
            {"disableComment": True},  # toggles without a privacy level
            "PUBLIC_TO_EVERYONE",  # a bare string from an older writer
            [],
        ],
    )
    def test_no_privacy_level_means_no_settings_at_all(self, raw):
        """The one field that cannot be defaulted.

        TikTok requires the creator to pick a visibility with nothing
        pre-selected, so there is no value this could fall back to. Anything
        that does not carry one is "no consent recorded", and the publisher
        sends those to the drafts inbox rather than choosing.
        """
        assert TikTokPostSettings.from_json(raw) is None


class TestWhatTikTokReceives:
    def test_carries_every_choice_into_post_info(self):
        info = TikTokPostSettings(
            privacy_level="PUBLIC_TO_EVERYONE",
            disable_comment=True,
            disable_duet=False,
            disable_stitch=True,
            brand_organic=True,
            branded_content=False,
        ).post_info("A caption")

        assert info["title"] == "A caption"
        assert info["privacy_level"] == "PUBLIC_TO_EVERYONE"
        assert info["disable_comment"] is True
        assert info["disable_duet"] is False
        assert info["disable_stitch"] is True
        assert info["brand_organic_toggle"] is True
        assert info["brand_content_toggle"] is False

    def test_uses_the_field_names_tiktok_documents(self):
        """`brand_content_toggle` and `brand_organic_toggle`, not the names the
        UI uses. TikTok ignores an unrecognised key rather than rejecting it, so
        a typo here is a disclosure that silently never happens -- which is the
        one failure mode with a regulator attached."""
        info = TikTokPostSettings(privacy_level="SELF_ONLY").post_info("x")
        assert set(info) == {
            "title",
            "privacy_level",
            "disable_comment",
            "disable_duet",
            "disable_stitch",
            "brand_content_toggle",
            "brand_organic_toggle",
        }

    def test_sends_booleans_rather_than_truthy_values(self):
        """A JSON column can hand back 1, "true", or "false". TikTok's API is
        typed, and "false" is truthy everywhere it is read as a string."""
        settings = TikTokPostSettings.from_json(
            {"privacyLevel": "SELF_ONLY", "disableComment": "false", "brandedContent": 1}
        )
        assert settings.disable_comment is True  # a non-empty string IS true
        assert settings.branded_content is True
        info = settings.post_info("x")
        assert isinstance(info["disable_comment"], bool)
        assert isinstance(info["brand_content_toggle"], bool)


class TestBrandedContentAndVisibility:
    """TikTok forbids branded content on a private post: a paid partnership
    that only the creator can see cannot be disclosed to anyone.

    Enforced in the composer, where the creator can still change their mind.
    Restated here because the two must not drift -- if the UI ever stops
    enforcing it, this is the test that says what the rule was.
    """

    def test_the_combination_the_ui_must_prevent(self):
        settings = TikTokPostSettings(privacy_level="SELF_ONLY", branded_content=True)
        info = settings.post_info("x")
        assert (info["privacy_level"] == "SELF_ONLY") and info["brand_content_toggle"], (
            "This combination is rejected by TikTok. The composer must not offer "
            "SELF_ONLY while Branded content is on -- see apps/web composer tests."
        )
