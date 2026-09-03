"""/health must answer, especially when things are broken.

It had no end-to-end test at all, and that is how it shipped a 500. Railway
gates the deploy on this path, so an exception here is not a bad status page --
it is a service that can never become healthy, holding the environment's deploy
slot while every other service queues behind it.

The bug that prompted this: `_beat_status` parsed the heartbeat into a NAIVE
datetime (the writer is `db.utcnow()`, naive because Prisma stores timestamp(3)
without a zone) and subtracted it from an AWARE `datetime.now(UTC)`. TypeError,
uncaught, on every request.

Its shape is the reason for testing the endpoint rather than only the helper:
with no heartbeat in Redis the function returns early, so /health was fine for
exactly as long as beat was broken, and began failing the moment beat started
working. Recovery is what triggered it.

So the rule these tests encode is blunt: whatever is down, /health returns 200
and says what is wrong in the body. It reports failure, it does not fail.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from godeye_engine.api import app
from godeye_engine.db import utcnow


@pytest.fixture
def client():
    # raise_server_exceptions=False so an unhandled exception arrives as the
    # 500 a deploy healthcheck would see, rather than as a pytest error.
    return TestClient(app, raise_server_exceptions=False)


def _redis_returning(heartbeat):
    fake = MagicMock()
    fake.get.return_value = heartbeat
    fake.ping.return_value = True
    return fake


def _health(client, heartbeat):
    """GET /health with the broker and database stubbed, so only the beat
    branch varies between cases."""
    with (
        patch("redis.Redis.from_url", return_value=_redis_returning(heartbeat)),
        patch("godeye_engine.api.get_engine", side_effect=OSError("no database here")),
        patch("godeye_engine.api.worker_builds", return_value=[]),
        patch(
            "godeye_engine.api.queue_coverage",
            return_value={"covered": [], "missing": [], "error": "stubbed"},
        ),
    ):
        return client.get("/health")


class TestItNeverReturnsFiveHundred:
    def test_with_the_real_writers_heartbeat(self, client):
        """The production 500, end to end. `utcnow()` is naive, and this is
        byte-for-byte what beat stores."""
        response = _health(client, utcnow().isoformat().encode())
        assert response.status_code == 200, response.text
        assert response.json()["checks"]["beat"].startswith("ok")

    def test_with_an_aware_heartbeat(self, client):
        response = _health(client, datetime.now(UTC).isoformat().encode())
        assert response.status_code == 200, response.text
        assert response.json()["checks"]["beat"].startswith("ok")

    def test_with_no_heartbeat_at_all(self, client):
        """The case that accidentally kept the endpoint alive: it returns
        before reaching the arithmetic."""
        response = _health(client, None)
        assert response.status_code == 200, response.text
        assert response.json()["checks"]["beat"].startswith("error")

    def test_with_a_heartbeat_that_is_not_a_timestamp(self, client):
        response = _health(client, b"\x80not-a-timestamp")
        assert response.status_code == 200, response.text
        assert response.json()["checks"]["beat"].startswith("error")

    def test_with_a_stale_heartbeat(self, client):
        response = _health(client, (utcnow() - timedelta(hours=9)).isoformat().encode())
        assert response.status_code == 200, response.text

    def test_the_body_still_says_what_is_wrong(self, client):
        """200 is only acceptable because the body carries the detail. A health
        endpoint that answers 200 and reports nothing is worse than one that
        crashes, because it is trusted."""
        body = _health(client, utcnow().isoformat().encode()).json()
        assert body["status"] == "degraded"
        assert body["checks"]["database"].startswith("error")
        assert body["checks"]["queues"].startswith("error")
