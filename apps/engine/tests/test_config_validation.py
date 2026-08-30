"""Which secrets are allowed to stop the engine booting.

The engine API crash-looped in production on this:

    InsecureConfigError: Refusing to start: 1 configuration problem(s)
      - INDEXNOW_KEY_SECRET is not set

IndexNow is one SEO submission to one search engine. Publishing, scheduling,
token refresh and metrics have nothing to do with it, and every one of them went
down with it.

`Settings.require()` already raises on a blank value at the point of use, and
`seo/indexnow.py` is the only reader in the codebase, so the feature failed
closed with or without a boot gate. The gate added no safety, only blast radius.

Failing closed is right. Failing closed on the entire engine because an optional
feature lacks a key is the wrong granularity, and that distinction is what these
tests hold in place.
"""

from __future__ import annotations

import os

import pytest

from godeye_engine.config import InsecureConfigError, get_settings, validate_config

#: A key generated per run, not a constant.
#:
#: The first draft used "a1b2c3d4" * 8, which is 64 valid hex characters and
#: exactly the kind of thing that looks like a key. The entropy check rejected
#: it for having four distinct byte values -- correctly, and it is pleasant to
#: be caught by your own guard. Generating one also means no string in this repo
#: can ever be mistaken for a real secret.
STRONG_HEX_KEY = os.urandom(32).hex()


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """`get_settings` is lru_cached, so a stale instance would make every test
    here read the previous test's environment."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _valid_core(monkeypatch) -> None:
    """The two secrets the engine genuinely cannot work without."""
    monkeypatch.setenv("ENGINE_INTERNAL_SECRET", "e" * 40)
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", STRONG_HEX_KEY)


class TestBootGateBlastRadius:
    def test_indexnow_missing_does_not_stop_the_engine(self, monkeypatch):
        """The exact production failure, as a test."""
        _valid_core(monkeypatch)
        monkeypatch.delenv("INDEXNOW_KEY_SECRET", raising=False)
        get_settings.cache_clear()
        validate_config()

    def test_the_feature_still_fails_closed_without_it(self, monkeypatch):
        """Narrowing the gate must not make the secret optional where it is
        actually used, or this would have traded a crash for a silently wrong
        IndexNow key published on a customer's website."""
        _valid_core(monkeypatch)
        monkeypatch.delenv("INDEXNOW_KEY_SECRET", raising=False)
        get_settings.cache_clear()
        with pytest.raises(InsecureConfigError, match="INDEXNOW_KEY_SECRET is not set"):
            get_settings().require("indexnow_key_secret")

    def test_a_secret_the_engine_truly_needs_still_stops_the_boot(self, monkeypatch):
        """The gate still exists and still bites. ENGINE_INTERNAL_SECRET
        authenticates every call the API makes into the engine."""
        monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", STRONG_HEX_KEY)
        monkeypatch.setenv("ENGINE_INTERNAL_SECRET", "")
        get_settings.cache_clear()
        with pytest.raises(InsecureConfigError, match="ENGINE_INTERNAL_SECRET"):
            validate_config()

    def test_a_malformed_encryption_key_still_stops_the_boot(self, monkeypatch):
        """Every stored platform credential is encrypted with this. A wrong key
        is not a degraded feature, it is every publish failing to decrypt."""
        monkeypatch.setenv("ENGINE_INTERNAL_SECRET", "e" * 40)
        monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", "abc123")
        get_settings.cache_clear()
        with pytest.raises(InsecureConfigError, match="TOKEN_ENCRYPTION_KEY"):
            validate_config()


class TestIndexNowKeySeparation:
    """S-6b: the IndexNow key is published on the customer's own website, so it
    must never be derived from the key that encrypts their platform tokens."""

    def test_rejects_reusing_the_encryption_key(self, monkeypatch):
        shared = STRONG_HEX_KEY
        monkeypatch.setenv("ENGINE_INTERNAL_SECRET", "e" * 40)
        monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", shared)
        monkeypatch.setenv("INDEXNOW_KEY_SECRET", shared)
        get_settings.cache_clear()
        with pytest.raises(InsecureConfigError, match="INDEXNOW_KEY_SECRET must not equal"):
            validate_config()

    def test_accepts_a_distinct_value(self, monkeypatch):
        _valid_core(monkeypatch)
        monkeypatch.setenv("INDEXNOW_KEY_SECRET", "i" * 40)
        get_settings.cache_clear()
        validate_config()
