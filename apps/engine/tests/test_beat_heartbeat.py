"""Beat has to be visible to the health check.

Four scheduled posts sat at PENDING for forty minutes past their time while
`/health` reported `status: ok`. Everything the endpoint looked at was genuinely
fine -- database ok, redis ok, workers ok, ffmpeg ok -- because every one of
those is a CONSUMER, and the thing that had stopped was the producer.

Celery beat is what turns "it is 12:37" into "dispatch this post". Nothing in
the health check could see it, so its failure mode was silent by construction:
the product stops working and the monitoring stays green.

The heartbeat is written inside `dispatch_due_posts`, a task only beat
schedules and only a worker runs, so a fresh key proves the whole
beat -> broker -> worker path rather than any single process being up.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

from godeye_engine.tasks.scheduler import (
    BEAT_HEARTBEAT_KEY,
    BEAT_HEARTBEAT_TTL_SEC,
    _record_beat_heartbeat,
)


class TestHeartbeatWrite:
    def test_records_the_time_with_an_expiry(self):
        client = MagicMock()
        now = datetime(2026, 8, 31, 12, 40, tzinfo=UTC)
        with patch("redis.Redis.from_url", return_value=client):
            _record_beat_heartbeat(now)

        client.set.assert_called_once()
        key, value = client.set.call_args[0]
        assert key == BEAT_HEARTBEAT_KEY
        assert value == now.isoformat()
        # The expiry IS the detector. Without it a key written once would say
        # beat was alive forever, which is worse than not checking at all.
        assert client.set.call_args[1]["ex"] == BEAT_HEARTBEAT_TTL_SEC

    def test_survives_redis_being_down(self):
        """Monitoring must never be able to stop the thing it monitors.

        This runs inside the dispatcher, after the rows have been selected. If a
        failure here propagated, an unreachable Redis would stop posts going out
        -- turning an observability gap into an outage.
        """
        with patch("redis.Redis.from_url", side_effect=OSError("connection refused")):
            _record_beat_heartbeat(datetime.now(UTC))  # must not raise

    def test_ttl_covers_several_missed_ticks(self):
        """Beat dispatches every 30 seconds. A TTL shorter than a couple of
        ticks would report an outage every time one run was slow."""
        assert BEAT_HEARTBEAT_TTL_SEC >= 90


class TestHealthReportsBeat:
    def _status(self, raw):
        from godeye_engine.api import _beat_status

        client = MagicMock()
        client.get.return_value = raw
        with patch("redis.Redis.from_url", return_value=client):
            return _beat_status()

    def test_a_fresh_heartbeat_reads_ok(self):
        recent = (datetime.now(UTC) - timedelta(seconds=20)).isoformat()
        assert self._status(recent.encode()).startswith("ok")

    def test_a_missing_heartbeat_is_an_error_that_says_what_to_do(self):
        """The exact production failure. The message has to name beat, because
        every other check was green and the next person will be looking at the
        worker."""
        status = self._status(None)
        assert status.startswith("error")
        assert "beat" in status.lower()
        assert "dispatch" in status.lower()

    def test_an_unreadable_heartbeat_is_an_error_rather_than_a_crash(self):
        assert self._status(b"not-a-timestamp").startswith("error")

    def test_redis_being_down_is_reported_not_raised(self):
        from godeye_engine.api import _beat_status

        with patch("redis.Redis.from_url", side_effect=OSError("refused")):
            assert _beat_status().startswith("error")


class TestTheWriterAndReaderAgreeOnFormat:
    """The reader has to accept what the writer actually produces.

    `/health` returned 500 on every request in production, and the healthcheck
    held the deploy down for it. The cause was entirely inside this pair:

        writer:  db.utcnow()  -> naive UTC, because Prisma stores
                                 timestamp(3) with no zone
        reader:  datetime.now(UTC) - datetime.fromisoformat(raw)
                              -> aware minus naive -> TypeError

    TestHealthReportsBeat above did not catch it because it builds its own
    timestamp with `datetime.now(UTC).isoformat()`, which is AWARE. The test
    invented a format the writer never emits, so reader and writer were each
    tested against a different contract and the pair was never tested at all.

    The failure mode is worth naming: with no heartbeat, `_beat_status` returns
    early and /health answers fine. It could only break once beat was healthy
    and writing keys. So the endpoint stayed up while the thing it monitors was
    down, and started 500ing when it recovered -- and because Railway gates the
    deploy on it, recovery is what blocked the deploy.

    So these go through the real writer. Nothing here fabricates a timestamp.
    """

    def _round_trip(self, written_value):
        """Write with the real writer, read with the real reader."""
        from godeye_engine.api import _beat_status

        store = {}
        writer = MagicMock()
        writer.set.side_effect = lambda key, value, **kw: store.__setitem__(key, value)
        with patch("redis.Redis.from_url", return_value=writer):
            _record_beat_heartbeat(written_value)

        raw = store[BEAT_HEARTBEAT_KEY]
        reader = MagicMock()
        reader.get.return_value = raw.encode() if isinstance(raw, str) else raw
        with patch("redis.Redis.from_url", return_value=reader):
            return _beat_status()

    def test_the_real_writers_timestamp_reads_ok(self):
        """`dispatch_due_posts` calls `_record_beat_heartbeat(utcnow())`, so
        this is the exact value production stores."""
        from godeye_engine.db import utcnow

        assert self._round_trip(utcnow()).startswith("ok")

    def test_utcnow_is_naive_which_is_why_this_matters(self):
        """Pins the premise. If utcnow() ever becomes aware this test should be
        revisited rather than silently passing for a different reason."""
        from godeye_engine.db import utcnow

        assert utcnow().tzinfo is None

    def test_an_aware_timestamp_still_reads_ok(self):
        """Both shapes, because a naive key written before this fix can still
        be in Redis alongside aware ones, and neither may 500."""
        assert self._round_trip(datetime.now(UTC)).startswith("ok")

    def test_the_age_is_right_and_not_off_by_a_timezone(self):
        """Normalising to UTC rather than local time. Attaching the wrong zone
        would still parse and subtract, and would report an age hours out --
        which reads as "beat is dead" on a system that is fine."""
        from godeye_engine.db import utcnow

        status = self._round_trip(utcnow())
        seconds = int(status.split("last dispatch ")[1].split("s ago")[0])
        assert 0 <= seconds < 5, status
