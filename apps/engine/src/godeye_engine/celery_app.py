"""Celery application + beat schedule."""

from __future__ import annotations

from celery import Celery

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
        "recycle-evergreen": {
            "task": "godeye_engine.tasks.planner.recycle_evergreen",
            "schedule": 6 * 3600.0,  # every 6 hours
        },
    },
)
