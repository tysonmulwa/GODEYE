"""Keep platform connections alive. Finding B-7.

``SocialConnection.expiresAt`` was written in four places by the API and read in
NONE, by anything, and the beat schedule had no refresh task. TikTok access
tokens live 24 hours, so **every TikTok connection stopped working a day after
it was made while the Connections page still showed ACTIVE**. Instagram and
LinkedIn long-lived tokens die at around 60 days, equally silently.

For a product whose whole promise is unattended publishing, that is the most
customer-visible defect in the audit: nothing errors, nothing alerts, posts
simply stop going out.

What this does, hourly:

1. Finds connections inside the refresh window and renews them.
2. Persists the result, including a **rotated refresh token** — several
   providers issue a new one on every use, and dropping it bricks the connection
   on the next cycle, which is worse than not refreshing at all.
3. Moves a connection through ACTIVE -> EXPIRING_SOON -> EXPIRED / REVOKED so
   the UI, the pre-publish check and the scheduler all agree on its state.
4. Emits an event per workspace so the browser can prompt a reconnect.

Refresh is jittered: 10,000 connections must not all renew in the same minute,
both for the providers' sake and for ours.
"""

from __future__ import annotations

import logging
import random
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update

from ..celery_app import app
from ..config import get_settings
from ..db import SocialConnection, get_engine
from ..events import publish_event
from ..metrics_registry import CONNECTION_REFRESH
from ..periodic_lock import once_per_tick
from ..publishers.base import TransientPublishError
from ..security import decrypt_credentials, encrypt_credentials

logger = logging.getLogger(__name__)

#: Renew anything expiring within this window. Wide enough that an hourly sweep
#: has several attempts before a token actually lapses.
REFRESH_WINDOW = timedelta(hours=24)
#: Spread the work so a large workspace does not renew everything at once.
MAX_JITTER_SECONDS = 900
#: Connections handled per sweep. The next tick takes the rest.
BATCH = 200
#: Above this share of failures the sweep says so loudly; it usually means an
#: app credential was rotated or an app was suspended, not 200 unlucky users.
FAILURE_ALERT_RATIO = 0.25


class RefreshUnsupported(Exception):
    """This platform's tokens do not expire, or cannot be refreshed unattended."""


class RefreshRevoked(Exception):
    """The provider says the grant is gone. Only reconnecting fixes it."""


def _refresh_tiktok(credentials: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """TikTok v2. Access token ~24h, refresh token ~365 days, and TikTok
    **rotates the refresh token on every use**."""
    from ..publishers.tiktok import API as TIKTOK_API  # local: avoids an import cycle

    settings = get_settings()
    refresh_token = credentials.get("refreshToken")
    if not refresh_token:
        raise RefreshUnsupported("no refresh token stored")

    import httpx  # lint-rules:allow — open.tiktokapis.com, a constant

    response = httpx.post(
        f"{TIKTOK_API}/oauth/token/",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "client_key": settings.tiktok_client_key,
            "client_secret": settings.tiktok_client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=15,
    )
    body = response.json() if response.content else {}
    if response.status_code >= 500:
        raise TransientPublishError(f"TikTok token endpoint returned {response.status_code}")
    if body.get("error") in {"invalid_grant", "access_denied"}:
        raise RefreshRevoked(str(body.get("error_description") or body.get("error")))
    access = body.get("access_token")
    if not access:
        raise RefreshRevoked(str(body.get("error_description") or body)[:200])

    return (
        {
            **credentials,
            "accessToken": access,
            # The rotated value. Keeping the old one here is the mistake that
            # turns a working refresh into a connection that dies next cycle.
            "refreshToken": body.get("refresh_token") or refresh_token,
        },
        int(body.get("expires_in") or 86400),
    )


def _refresh_instagram(credentials: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Instagram Login long-lived tokens are refreshed by exchanging the token
    for itself; there is no separate refresh token."""
    token = credentials.get("accessToken")
    if not token:
        raise RefreshUnsupported("no access token stored")

    import httpx  # lint-rules:allow — graph.instagram.com, a constant

    response = httpx.get(
        "https://graph.instagram.com/refresh_access_token",
        params={"grant_type": "ig_refresh_token", "access_token": token},
        timeout=15,
    )
    body = response.json() if response.content else {}
    if response.status_code >= 500:
        raise TransientPublishError(f"Instagram token endpoint returned {response.status_code}")
    access = body.get("access_token")
    if not access:
        raise RefreshRevoked(str(body.get("error") or body)[:200])
    return ({**credentials, "accessToken": access}, int(body.get("expires_in") or 5_184_000))


def _refresh_reddit(credentials: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Reddit access tokens live an hour. The publisher already exchanges at post
    time; this keeps a connection that has not posted recently from looking dead."""
    settings = get_settings()
    refresh_token = credentials.get("refreshToken")
    if not refresh_token:
        raise RefreshUnsupported("no refresh token stored")
    if not settings.reddit_client_id or not settings.reddit_client_secret:
        raise RefreshUnsupported("Reddit app credentials are not configured")

    import httpx  # lint-rules:allow — www.reddit.com, a constant

    response = httpx.post(
        "https://www.reddit.com/api/v1/access_token",
        auth=(settings.reddit_client_id, settings.reddit_client_secret),
        headers={"User-Agent": settings.reddit_user_agent},
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        timeout=15,
    )
    body = response.json() if response.content else {}
    if response.status_code >= 500:
        raise TransientPublishError(f"Reddit token endpoint returned {response.status_code}")
    access = body.get("access_token")
    if not access:
        raise RefreshRevoked(str(body.get("error") or body)[:200])
    return (
        {
            **credentials,
            "accessToken": access,
            "refreshToken": body.get("refresh_token") or refresh_token,
        },
        int(body.get("expires_in") or 3600),
    )


def _refresh_unsupported(_credentials: dict[str, Any]) -> tuple[dict[str, Any], int]:
    raise RefreshUnsupported("this platform's tokens cannot be refreshed unattended")


#: LinkedIn is deliberately absent from the refreshable set. Its refresh-token
#: grant is limited to approved partners; for everybody else a 60-day token
#: simply ends and the person must reconnect. Saying so in the data — EXPIRING_SOON,
#: then EXPIRED — is the whole fix there. Facebook Page tokens derived from a
#: long-lived user token do not expire, and X uses OAuth 1.0a, whose tokens do not
#: either.
REFRESHERS = {
    "TIKTOK": _refresh_tiktok,
    "INSTAGRAM": _refresh_instagram,
    "REDDIT": _refresh_reddit,
    "LINKEDIN": _refresh_unsupported,
    "FACEBOOK": _refresh_unsupported,
    "X": _refresh_unsupported,
    "TELEGRAM": _refresh_unsupported,
    "DISCORD": _refresh_unsupported,
}


def _due(now: datetime) -> list[dict[str, Any]]:
    cutoff = now + REFRESH_WINDOW
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(
                SocialConnection.c.id,
                SocialConnection.c.orgId,
                SocialConnection.c.platform,
                SocialConnection.c.displayName,
                SocialConnection.c.encryptedCredentials,
                SocialConnection.c.expiresAt,
            )
            .where(
                SocialConnection.c.expiresAt.isnot(None),
                SocialConnection.c.expiresAt <= cutoff,
                SocialConnection.c.status.in_(["ACTIVE", "EXPIRING_SOON"]),
            )
            .order_by(SocialConnection.c.expiresAt.asc())
            .limit(BATCH)
        ).mappings()
        return [dict(row) for row in rows]


def _save(connection_id: str, **values: Any) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            update(SocialConnection)
            .where(SocialConnection.c.id == connection_id)
            .values(updatedAt=datetime.now(UTC).replace(tzinfo=None), **values)
        )


def _notify(org_id: str, connection: dict[str, Any], status: str, message: str) -> None:
    """Tell the workspace, so a dead channel is visible before a post is missed."""
    try:
        publish_event(
            org_id,
            {
                "type": "connection.status_changed",
                "connectionId": connection["id"],
                "platform": connection["platform"],
                "displayName": connection["displayName"],
                "status": status,
                "message": message,
            },
        )
    except Exception as e:  # noqa: BLE001 - a notification must not fail the sweep
        logger.warning("Could not publish a connection status event: %s", e)


@app.task(name="godeye_engine.tasks.token_refresh.refresh_expiring_connections")
@once_per_tick("refresh-connections", 3000)
def refresh_expiring_connections() -> dict:
    now = datetime.now(UTC).replace(tzinfo=None)
    due = _due(now)
    if not due:
        return {"checked": 0, "refreshed": 0, "expired": 0, "revoked": 0}

    refreshed = expired = revoked = failed = 0

    for connection in due:
        platform = str(connection["platform"])
        expires_at = connection["expiresAt"]
        lapsed = expires_at is not None and expires_at <= now

        try:
            credentials = decrypt_credentials(
                connection["encryptedCredentials"], connection["orgId"]
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Cannot decrypt credentials for %s: %s", connection["id"], e)
            _save(connection["id"], status="ERROR", lastError=str(e)[:500], lastErrorAt=now)
            failed += 1
            continue

        refresher = REFRESHERS.get(platform, _refresh_unsupported)
        try:
            updated, expires_in = refresher(credentials)
        except RefreshUnsupported as e:
            # Nothing to do but say so honestly: EXPIRING_SOON while there is
            # still time, EXPIRED once there is not. Silence was the finding.
            status = "EXPIRED" if lapsed else "EXPIRING_SOON"
            _save(
                connection["id"],
                status=status,
                lastError=f"This connection needs to be re-authorised: {e}"[:500],
                lastErrorAt=now,
                lastCheckedAt=now,
            )
            _notify(connection["orgId"], connection, status, str(e))
            CONNECTION_REFRESH.labels(
                platform=platform, outcome="expired" if lapsed else "unsupported"
            ).inc()
            expired += 1 if lapsed else 0
            continue
        except RefreshRevoked as e:
            _save(
                connection["id"],
                status="REVOKED",
                lastError=f"{platform} revoked this connection: {e}"[:500],
                lastErrorAt=now,
                lastCheckedAt=now,
            )
            _notify(connection["orgId"], connection, "REVOKED", str(e))
            CONNECTION_REFRESH.labels(platform=platform, outcome="revoked").inc()
            revoked += 1
            continue
        except Exception as e:  # noqa: BLE001 - one bad connection must not stop the sweep
            failed += 1
            status = "EXPIRED" if lapsed else "EXPIRING_SOON"
            logger.warning("Refresh failed for %s (%s): %s", connection["id"], platform, e)
            _save(
                connection["id"],
                status=status,
                lastError=f"Could not refresh this connection: {e}"[:500],
                lastErrorAt=now,
                lastCheckedAt=now,
            )
            CONNECTION_REFRESH.labels(platform=platform, outcome="failed").inc()
            if lapsed:
                expired += 1
                _notify(connection["orgId"], connection, status, str(e))
            continue

        # Jitter the NEXT due time rather than sleeping here: sleeping would hold
        # a worker slot, and the point is only that ten thousand connections do
        # not come due in the same minute.
        jitter = random.randint(0, MAX_JITTER_SECONDS)
        _save(
            connection["id"],
            status="ACTIVE",
            encryptedCredentials=encrypt_credentials(updated, connection["orgId"]),
            expiresAt=now + timedelta(seconds=max(60, expires_in - jitter)),
            lastError=None,
            lastErrorAt=None,
            lastCheckedAt=now,
        )
        CONNECTION_REFRESH.labels(platform=platform, outcome="refreshed").inc()
        refreshed += 1

    result = {
        "checked": len(due),
        "refreshed": refreshed,
        "expired": expired,
        "revoked": revoked,
        "failed": failed,
    }
    if due and failed / len(due) >= FAILURE_ALERT_RATIO:
        # An app credential rotated, or an app was suspended. That is one problem
        # affecting everybody, not many users being unlucky, and it reads very
        # differently in a log.
        logger.error(
            "Token refresh failure rate %.0f%% (%d of %d) - check the platform app "
            "credentials, not the individual connections",
            100 * failed / len(due),
            failed,
            len(due),
        )
    else:
        logger.info("Token refresh sweep: %s", result)
    return result
