"""Celery application + beat schedule."""

from __future__ import annotations

from celery import Celery
from celery.worker.control import control_command

from .config import get_settings

settings = get_settings()

app = Celery(
    "godeye_engine",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "godeye_engine.tasks.content",
        "godeye_engine.tasks.scheduler",
        "godeye_engine.tasks.planner",
        "godeye_engine.tasks.metrics",
        "godeye_engine.tasks.image",
        "godeye_engine.tasks.video",
        "godeye_engine.tasks.seo",
        "godeye_engine.tasks.diagnostics",
    ],
)

app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    # Nothing may occupy a worker slot indefinitely. The worker runs with
    # --concurrency=2, so two wedged tasks stop everything else, publishing
    # included. These are the outer bounds; video assembly is the slowest
    # legitimate task and individual tasks tighten them further.
    #
    # The soft limit matters more than the hard one: it raises inside the task,
    # so the handler marks the run FAILED and the message is acked. A hard kill
    # under task_acks_late would return the message to the queue and the same
    # task would wedge the next worker that picked it up.
    task_soft_time_limit=20 * 60,
    task_time_limit=25 * 60,
    beat_schedule={
        "dispatch-due-posts": {
            "task": "godeye_engine.tasks.scheduler.dispatch_due_posts",
            "schedule": 30.0,  # seconds
        },
        "plan-autopilot": {
            "task": "godeye_engine.tasks.planner.plan_autopilot",
            "schedule": 300.0,  # 5 minutes
        },
        "collect-metrics": {
            "task": "godeye_engine.tasks.metrics.collect_metrics",
            "schedule": 3600.0,  # hourly
        },
        "reap-stale-runs": {
            "task": "godeye_engine.tasks.scheduler.reap_stale_runs",
            "schedule": 120.0,  # 2 minutes
        },
        "reap-stuck-posts": {
            "task": "godeye_engine.tasks.scheduler.reap_stuck_posts",
            "schedule": 120.0,  # 2 minutes
        },
        "recycle-evergreen": {
            "task": "godeye_engine.tasks.planner.recycle_evergreen",
            "schedule": 6 * 3600.0,  # every 6 hours
        },
    },
)


# The worker is the service that actually publishes, and it is the one service
# that could not be asked what it was running. /health covers the engine web
# process, but that is a different Railway service off the same image, and the
# two deploy independently — so a healthy web build says nothing about the code
# doing the work.
#
# A control command answers from inside the worker process itself, and every
# node replies separately. That matters: a broadcast reveals how many workers
# are consuming the queue, which a build hash cannot. A container left over from
# an earlier deploy keeps taking tasks, so publishes land on old code at random
# and the symptom comes and goes for no visible reason.
@control_command()
def build_info(state) -> dict:  # noqa: ANN001 — Celery hands in its worker state
    sha = get_settings().railway_git_commit_sha
    # Whether the worker can render is a separate question from which build it
    # is on, and it is the one that decides if a TikTok post gets sound. The
    # slideshow falls back to a silent photo carousel when ffmpeg is missing,
    # so from the outside that failure is invisible.
    return {"build": sha[:8] if sha else "unknown", "ffmpeg": _ffmpeg_status()}


def _ffmpeg_status() -> str:
    """Where ffmpeg is, or why rendering is impossible here."""
    import subprocess

    from .media import video

    try:
        path = video.locate_ffmpeg()
    except Exception as e:  # noqa: BLE001
        return f"missing: {e}"
    try:
        # Present on PATH is not the same as runnable — a wrong architecture or
        # a missing shared library only shows up on exec.
        proc = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=15)
    except Exception as e:  # noqa: BLE001
        return f"not runnable: {type(e).__name__}: {e}"
    if proc.returncode != 0:
        return f"exited {proc.returncode}"
    first = (proc.stdout or "").splitlines()
    return first[0][:60] if first else "ok"


def worker_builds(timeout: float = 2.0) -> list[dict]:
    """Ask every live worker which build it is running.

    Returns one entry per node. An empty list means nothing is consuming the
    queue — scheduled posts would sit unpublished forever, and until now that
    looked identical to a healthy system with nothing due.
    """
    try:
        # Own the connection rather than letting broadcast open one. Kombu
        # retries a refused broker with a backoff, which turned a health check
        # into a 13 second request — and a health check that hangs is one more
        # thing to debug during an outage. One attempt, then report.
        with app.connection_for_write(connect_timeout=timeout) as conn:
            conn.ensure_connection(max_retries=0, timeout=timeout)
            replies = (
                app.control.broadcast("build_info", reply=True, timeout=timeout, connection=conn)
                or []
            )
    except Exception as e:  # noqa: BLE001 — an unreachable broker is a report, not a crash
        return [{"node": "unknown", "build": "unknown", "error": str(e)}]

    nodes: list[dict] = []
    for reply in replies:
        for node, payload in reply.items():
            ok = isinstance(payload, dict)
            nodes.append({
                "node": node,
                "build": payload.get("build", "unknown") if ok else "unknown",
                "ffmpeg": payload.get("ffmpeg", "unknown") if ok else "unknown",
            })
    return sorted(nodes, key=lambda n: n["node"])
