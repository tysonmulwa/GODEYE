"""Diagnostics that have to run where the work runs.

The render self-test began as a control command answered inline, which meant
the HTTP request had to stay open for the length of an encode. It does not:
the edge closes the connection at 100 seconds and returns 524, and the answer
is lost even though the worker finished the job.

So it runs as a task and leaves its result in Redis. The request that asks for
it starts it and returns; the next request reads it.
"""

from __future__ import annotations

import json
import logging
import socket
from datetime import UTC, datetime

from ..celery_app import app
from ..config import get_settings

logger = logging.getLogger(__name__)

RENDER_RESULT_KEY = "godeye:diagnostics:render-selftest"
# Long enough to still be there when someone looks, short enough that nobody
# reads a stale pass after the thing has been fixed or broken again.
RESULT_TTL_SEC = 3600


def _redis():
    import redis as redis_lib

    return redis_lib.Redis.from_url(
        get_settings().redis_url, socket_connect_timeout=5, socket_timeout=5
    )


def read_render_result() -> dict | None:
    try:
        raw = _redis().get(RENDER_RESULT_KEY)
    except Exception as e:  # noqa: BLE001
        return {"error": f"could not read the stored result: {e}"}
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


@app.task(name="godeye_engine.tasks.diagnostics.render_selftest_task", soft_time_limit=900)
def render_selftest_task() -> dict:
    """Encode a throwaway slideshow here and record what happened."""
    from ..media.selftest import render_selftest

    result = render_selftest()
    result["node"] = socket.gethostname()
    result["at"] = datetime.now(UTC).isoformat(timespec="seconds")
    sha = get_settings().railway_git_commit_sha
    result["build"] = sha[:8] if sha else "unknown"
    logger.info("Render self-test: %s", result)
    try:
        _redis().set(RENDER_RESULT_KEY, json.dumps(result), ex=RESULT_TTL_SEC)
    except Exception as e:  # noqa: BLE001, the log still carries it
        logger.warning("Could not store the render self-test result: %s", e)
    return result


def start_render_selftest() -> bool:
    """Queue a run. False if the queue could not be reached."""
    try:
        render_selftest_task.delay()
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not queue the render self-test: %s", e)
        return False
