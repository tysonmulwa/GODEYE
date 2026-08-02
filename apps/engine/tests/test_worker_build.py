"""Reporting which build each worker is running.

The bug this exists to catch is not a crash. It is a queue consumed by a
container from an earlier deploy, where publishing quietly uses old code and
/health stays green because the web process is fine.
"""

from __future__ import annotations

import contextlib
from unittest.mock import MagicMock, patch

from godeye_engine.celery_app import worker_builds


@contextlib.contextmanager
def _broadcast(replies=None, connect_error: Exception | None = None):
    """Stand in for a live broker. The connection is patched as well as the
    broadcast: worker_builds opens its own so a refused broker fails fast
    instead of retrying, and an unpatched one reaches for real localhost."""
    with patch("godeye_engine.celery_app.app.connection_for_write") as factory:
        if connect_error is not None:
            factory.side_effect = connect_error
        else:
            factory.return_value.__enter__.return_value = MagicMock()
        with patch("godeye_engine.celery_app.app.control.broadcast", return_value=replies):
            yield


def test_flattens_one_reply_per_node():
    with _broadcast([
        {"celery@aaa": {"build": "07eda6d4", "ffmpeg": "ffmpeg version 6.1"}},
        {"celery@bbb": {"build": "83ecc241", "ffmpeg": "ffmpeg version 6.1"}},
    ]):
        assert worker_builds() == [
            {"node": "celery@aaa", "build": "07eda6d4", "ffmpeg": "ffmpeg version 6.1"},
            {"node": "celery@bbb", "build": "83ecc241", "ffmpeg": "ffmpeg version 6.1"},
        ]


def test_reports_every_node_when_one_reply_carries_several():
    """Celery may batch nodes into a single reply dict; none may be dropped."""
    with _broadcast([{"celery@aaa": {"build": "abc"}, "celery@bbb": {"build": "def"}}]):
        assert [n["node"] for n in worker_builds()] == ["celery@aaa", "celery@bbb"]


def test_no_workers_is_an_empty_list_not_an_error():
    """Nothing consuming the queue is the condition worth surfacing, and
    Celery reports it as an empty broadcast rather than by raising."""
    with _broadcast([]):
        assert worker_builds() == []
    with _broadcast(None):
        assert worker_builds() == []


def test_unreachable_broker_reports_rather_than_raises():
    with _broadcast(connect_error=OSError("connection refused")):
        nodes = worker_builds()
    assert len(nodes) == 1
    assert "connection refused" in nodes[0]["error"]


def _health(workers, sha):
    with (
        patch("godeye_engine.api.worker_builds", return_value=workers),
        patch("godeye_engine.api.get_settings") as settings,
        patch("godeye_engine.api.get_engine"),
        # health() pings Redis directly; without this each test waits out a
        # real connection to localhost.
        patch("redis.Redis.from_url"),
    ):
        settings.return_value.railway_git_commit_sha = sha
        settings.return_value.redis_url = "redis://localhost:6379/0"
        from godeye_engine.api import health

        return health()


FFMPEG_OK = "ffmpeg version 6.1.1"


def test_health_is_green_only_when_workers_match_this_build():
    result = _health(
        [{"node": "celery@aaa", "build": "07eda6d4", "ffmpeg": FFMPEG_OK}], "07eda6d4ff"
    )
    assert result["checks"]["workers"].startswith("ok")
    assert result["checks"]["ffmpeg"] == "ok"


def test_health_flags_a_worker_that_cannot_render():
    """A current worker with no ffmpeg still publishes — it drops the sound and
    falls back to a silent photo carousel without saying anything."""
    result = _health(
        [{"node": "celery@aaa", "build": "07eda6d4", "ffmpeg": "missing: not found on PATH"}],
        "07eda6d4ff",
    )
    assert result["status"] == "degraded"
    assert result["checks"]["workers"].startswith("ok"), "the build itself is fine"
    assert "not found on PATH" in result["checks"]["ffmpeg"]


def test_health_flags_a_worker_left_on_an_older_build():
    """The one this endpoint exists for: web deployed, worker did not, and the
    old container is still taking tasks off the queue."""
    result = _health(
        [{"node": "celery@new", "build": "07eda6d4"}, {"node": "celery@old", "build": "83ecc241"}],
        "07eda6d4ff",
    )
    assert result["status"] == "degraded"
    assert "celery@old=83ecc241" in result["checks"]["workers"]
    assert "celery@new" not in result["checks"]["workers"]


def test_health_never_calls_two_unknowns_a_match():
    """Regression: with no SHA on either side the comparison trivially passed
    and reported ok while the broker was refusing connections."""
    result = _health([{"node": "celery@aaa", "build": "unknown"}], "")
    assert result["status"] == "degraded"
    assert not result["checks"]["workers"].startswith("ok")


def test_health_reports_a_broker_error_over_a_build_mismatch():
    result = _health(
        [{"node": "unknown", "build": "unknown", "error": "connection refused"}], "07eda6d4ff"
    )
    assert "connection refused" in result["checks"]["workers"]


def test_health_says_when_nothing_is_consuming_the_queue():
    result = _health([], "07eda6d4ff")
    assert result["status"] == "degraded"
    assert "no worker responded" in result["checks"]["workers"]


def test_worker_without_the_env_var_says_unknown():
    """A worker on an older image has no build_info command and replies with an
    error payload. That must not be mistaken for a matching build."""
    with _broadcast([{"celery@old": {"error": "Unknown command: 'build_info'"}}]):
        assert worker_builds() == [
            {"node": "celery@old", "build": "unknown", "ffmpeg": "unknown"}
        ]
