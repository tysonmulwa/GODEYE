"""Platform tokens must be refreshed, and a dead connection must say so. B-7.

`SocialConnection.expiresAt` was written in four places by the API and read in
NONE. There was no refresh task at all. TikTok access tokens live 24 hours, so
every TikTok connection stopped working a day after it was made while the
Connections page still showed ACTIVE.
"""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from godeye_engine.tasks import token_refresh
from godeye_engine.tasks.token_refresh import (
    REFRESHERS,
    RefreshRevoked,
    RefreshUnsupported,
    _refresh_instagram,
    _refresh_reddit,
    _refresh_tiktok,
    refresh_expiring_connections,
)

NOW = datetime.now(UTC).replace(tzinfo=None)


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.content = json.dumps(payload).encode()

    def json(self) -> dict:
        return self._payload


@pytest.fixture(autouse=True)
def app_credentials(monkeypatch):
    from godeye_engine.config import get_settings

    monkeypatch.setenv("TIKTOK_CLIENT_KEY", "ck")
    monkeypatch.setenv("TIKTOK_CLIENT_SECRET", "cs")
    monkeypatch.setenv("REDDIT_CLIENT_ID", "rid")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "rsecret")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------- the per-platform refreshers ----------


def test_tiktok_persists_the_ROTATED_refresh_token(monkeypatch):
    """The mistake that turns a working refresh into a connection that dies.

    TikTok issues a new refresh token on every use. Keeping the old one means
    the next cycle fails, which is worse than not refreshing at all.
    """
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *a, **k: FakeResponse(
            {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 86400}
        ),
    )
    updated, expires_in = _refresh_tiktok({"accessToken": "old", "refreshToken": "old-refresh"})

    assert updated["accessToken"] == "new-access"
    assert updated["refreshToken"] == "new-refresh"
    assert expires_in == 86400


def test_tiktok_keeps_the_old_refresh_token_when_none_is_returned(monkeypatch):
    monkeypatch.setattr(
        httpx, "post", lambda *a, **k: FakeResponse({"access_token": "new", "expires_in": 100})
    )
    updated, _ = _refresh_tiktok({"refreshToken": "keep-me"})
    assert updated["refreshToken"] == "keep-me"


def test_tiktok_reports_a_revoked_grant_distinctly(monkeypatch):
    # REVOKED and EXPIRED need different words in the UI: one is "sign in
    # again", the other is "you removed our access".
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *a, **k: FakeResponse({"error": "invalid_grant", "error_description": "revoked"}),
    )
    with pytest.raises(RefreshRevoked):
        _refresh_tiktok({"refreshToken": "gone"})


def test_a_5xx_is_transient_not_revoked(monkeypatch):
    # Marking a connection REVOKED because TikTok had a bad minute would tell a
    # customer to reconnect a channel that is fine.
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResponse({}, 503))
    with pytest.raises(Exception) as caught:
        _refresh_tiktok({"refreshToken": "x"})
    assert not isinstance(caught.value, RefreshRevoked)


def test_instagram_exchanges_the_token_for_itself(monkeypatch):
    monkeypatch.setattr(
        httpx,
        "get",
        lambda *a, **k: FakeResponse({"access_token": "fresh", "expires_in": 5_184_000}),
    )
    updated, expires_in = _refresh_instagram({"accessToken": "stale", "igUserId": "1"})
    assert updated["accessToken"] == "fresh"
    assert updated["igUserId"] == "1"  # the rest of the credential survives
    assert expires_in == 5_184_000


def test_reddit_refresh_needs_app_credentials(monkeypatch):
    from godeye_engine.config import get_settings

    monkeypatch.setenv("REDDIT_CLIENT_ID", "")
    get_settings.cache_clear()
    with pytest.raises(RefreshUnsupported):
        _refresh_reddit({"refreshToken": "x"})


def test_a_connection_with_no_refresh_token_is_not_an_error(monkeypatch):
    with pytest.raises(RefreshUnsupported):
        _refresh_tiktok({"accessToken": "only"})


def test_every_platform_has_an_explicit_decision():
    """No platform may fall through by accident.

    A missing entry would silently mean "never refreshed", which is the finding.
    """
    from godeye_engine.publishers import _PUBLISHERS  # the registry of what we publish to

    for platform in _PUBLISHERS:
        assert platform in REFRESHERS, f"{platform} has no refresh decision"


# ---------- the sweep ----------


def _connection(**over):
    from godeye_engine.security import encrypt_credentials

    base = {
        "id": "conn_1",
        "orgId": "org_1",
        "platform": "TIKTOK",
        "displayName": "@shop",
        "encryptedCredentials": encrypt_credentials(
            {"accessToken": "old", "refreshToken": "old-refresh"}, "org_1"
        ),
        "expiresAt": NOW + timedelta(hours=2),
    }
    base.update(over)
    return base


@pytest.fixture
def sweep(monkeypatch):
    """Drive the sweep without a database, capturing what it would have written."""
    monkeypatch.setenv(
        "TOKEN_ENCRYPTION_KEY",
        "b3126e1542fa317004bc1c192e87c6afc2bbfae1674ffae2b159df41d7743209",
    )
    from godeye_engine.config import get_settings

    get_settings.cache_clear()

    saved: list[tuple[str, dict]] = []
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(token_refresh, "_save", lambda cid, **v: saved.append((cid, v)))
    monkeypatch.setattr(
        token_refresh,
        "_notify",
        lambda org, conn, status, message: events.append((status, {"org": org, "msg": message})),
    )
    return saved, events


def test_a_refreshed_connection_is_ACTIVE_with_a_new_expiry(monkeypatch, sweep):
    saved, _events = sweep
    monkeypatch.setattr(token_refresh, "_due", lambda now: [_connection()])
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *a, **k: FakeResponse(
            {"access_token": "new", "refresh_token": "rotated", "expires_in": 86400}
        ),
    )

    result = refresh_expiring_connections()

    assert result["refreshed"] == 1
    (_cid, values) = saved[0]
    assert values["status"] == "ACTIVE"
    assert values["expiresAt"] > NOW
    assert values["lastError"] is None
    # And the rotated token was actually written back, encrypted for this org.
    from godeye_engine.security import decrypt_credentials

    assert decrypt_credentials(values["encryptedCredentials"], "org_1")["refreshToken"] == "rotated"


def test_a_lapsed_connection_that_cannot_refresh_is_marked_EXPIRED(monkeypatch, sweep):
    """The assertion the audit's B-7 is really about.

    A connection whose token has already lapsed and cannot be renewed must stop
    saying ACTIVE. Nothing in the system ever wrote EXPIRED before this.
    """
    saved, events = sweep
    monkeypatch.setattr(
        token_refresh,
        "_due",
        lambda now: [_connection(platform="LINKEDIN", expiresAt=NOW - timedelta(hours=1))],
    )

    result = refresh_expiring_connections()

    assert result["expired"] == 1
    assert saved[0][1]["status"] == "EXPIRED"
    # And the workspace is told, rather than discovering it from a missed post.
    assert events and events[0][0] == "EXPIRED"


def test_a_connection_not_yet_lapsed_is_EXPIRING_SOON_not_EXPIRED(monkeypatch, sweep):
    # There is still time to reconnect; calling it EXPIRED would be a lie that
    # costs the customer a working channel.
    saved, _events = sweep
    monkeypatch.setattr(
        token_refresh,
        "_due",
        lambda now: [_connection(platform="LINKEDIN", expiresAt=NOW + timedelta(hours=6))],
    )

    refresh_expiring_connections()
    assert saved[0][1]["status"] == "EXPIRING_SOON"


def test_a_revoked_grant_is_REVOKED(monkeypatch, sweep):
    saved, events = sweep
    monkeypatch.setattr(token_refresh, "_due", lambda now: [_connection()])
    monkeypatch.setattr(
        httpx, "post", lambda *a, **k: FakeResponse({"error": "invalid_grant"})
    )

    result = refresh_expiring_connections()

    assert result["revoked"] == 1
    assert saved[0][1]["status"] == "REVOKED"
    assert events[0][0] == "REVOKED"


def test_one_bad_connection_does_not_stop_the_sweep(monkeypatch, sweep):
    saved, _events = sweep
    monkeypatch.setattr(
        token_refresh,
        "_due",
        lambda now: [_connection(id="bad", encryptedCredentials="not-a-blob"), _connection(id="good")],
    )
    monkeypatch.setattr(
        httpx, "post", lambda *a, **k: FakeResponse({"access_token": "n", "expires_in": 900})
    )

    result = refresh_expiring_connections()

    assert result["checked"] == 2
    assert result["refreshed"] == 1
    assert {cid for cid, _ in saved} == {"bad", "good"}


def test_the_next_expiry_is_jittered(monkeypatch, sweep):
    """Ten thousand connections must not all come due in the same minute."""
    saved, _events = sweep
    monkeypatch.setattr(
        token_refresh, "_due", lambda now: [_connection(id=f"c{i}") for i in range(20)]
    )
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *a, **k: FakeResponse({"access_token": "n", "expires_in": 86400}),
    )

    refresh_expiring_connections()
    expiries = {values["expiresAt"] for _cid, values in saved}
    assert len(expiries) > 1


def test_nothing_due_is_not_an_error(monkeypatch, sweep):
    monkeypatch.setattr(token_refresh, "_due", lambda now: [])
    assert refresh_expiring_connections()["checked"] == 0


# ---------- the column now has a reader ----------


def test_expires_at_is_actually_read():
    """B-7 in one line: the column was written in four places and read in none."""
    from pathlib import Path

    engine_src = Path(__file__).resolve().parents[1] / "src" / "godeye_engine"
    readers = [
        path
        for path in engine_src.rglob("*.py")
        if "expiresAt" in path.read_text(encoding="utf-8")
    ]
    assert readers, "nothing reads SocialConnection.expiresAt"
