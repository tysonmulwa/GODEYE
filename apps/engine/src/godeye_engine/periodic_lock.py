"""One run per tick, however many schedulers are firing.

Celery beat assumes there is exactly one of it. Run two and every periodic task
is scheduled twice; the tasks themselves have no idea and no way to tell.

That happened in production. The worker runs ``--beat``, so each replica is also
a scheduler, and a deploy that never finished left old containers alive
alongside new ones -- ``mingle: sync with 4 nodes``. The logs then showed
``plan_autopilot`` received twice, five seconds apart, for a task scheduled
every five minutes:

    17:28:28  plan_autopilot[214d434e...] received
    17:28:33  plan_autopilot[a61020b7...] received

``dispatch_due_posts`` survives that on its own -- it claims rows with
``FOR UPDATE SKIP LOCKED``, so a second copy finds nothing and a post is still
published once. Nothing else has that protection. Two planners can plan the same
slot twice, two metric collectors double-count, two retention sweeps race each
other's deletes.

So the guard belongs here rather than in each task: one Redis key per task name,
``SET NX PX``, and whoever gets it runs.

## What this is not

It is not a distributed lock in the Redlock sense, and does not need to be. The
worst case of a lost lock is the work happening twice, which is what happens
today without it. It is a way to make the common case single, not a correctness
mechanism to build on.

## Redis being down means the task RUNS

Deliberately, and it is the opposite of the choice made for rate limiting. A
periodic task that stops when Redis is unavailable is a scheduler that quietly
does nothing during exactly the incident you need it working through -- and
these tasks are the ones that publish posts and refresh expiring tokens. The
duplicate-work risk only exists when there are several beats, which is itself a
deployment fault; the not-running risk exists every time Redis hiccups.
"""

from __future__ import annotations

import logging
import os
import socket
from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar

from .config import get_settings

logger = logging.getLogger(__name__)

#: Identifies the holder in the key's value. Only ever read by a human staring
#: at Redis wondering which container is winning.
HOLDER = f"{socket.gethostname()}:{os.getpid()}"

F = TypeVar("F", bound=Callable[..., Any])


def _client():
    import redis as redis_lib

    return redis_lib.Redis.from_url(
        get_settings().redis_url, socket_connect_timeout=2, socket_timeout=2
    )


def acquire(name: str, ttl_seconds: int) -> bool:
    """Claim the tick for ``name``. True if this process should do the work.

    The TTL is what releases it: the lock is never deleted on completion, so a
    task that crashes halfway cannot leave the schedule stuck. Set it just under
    the task's interval, so the next tick is a fresh contest.
    """
    try:
        got = _client().set(f"godeye:tick:{name}", HOLDER, nx=True, ex=ttl_seconds)
    except Exception as e:  # noqa: BLE001
        # Run anyway. See the module docstring: not running is the worse
        # failure, and duplicate work needs a second beat to even be possible.
        logger.warning("tick lock for %s unavailable (%s); running without it", name, e)
        return True
    return bool(got)


def once_per_tick(name: str, ttl_seconds: int) -> Callable[[F], F]:
    """Skip the body when another scheduler already claimed this tick.

    Returns ``None`` when it stands down, which Celery records as a normal
    result. A skipped tick is not an error and must not be retried: the work is
    being done by whoever holds the lock.
    """

    def decorate(fn: F) -> F:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not acquire(name, ttl_seconds):
                logger.info("%s: another scheduler holds this tick, standing down", name)
                return None
            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorate
