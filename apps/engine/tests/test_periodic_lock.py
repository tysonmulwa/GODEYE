"""One run per tick, however many schedulers are firing.

Written from a production log. The worker runs `--beat`, so every replica is
also a scheduler, and a deploy that never finished left old containers running
alongside new ones (`mingle: sync with 4 nodes`). The result was visible:

    17:28:28  plan_autopilot[214d434e...] received
    17:28:33  plan_autopilot[a61020b7...] received

Two task ids five seconds apart, for a task scheduled every five minutes. Two
beats. `dispatch_due_posts` survives that on its own via FOR UPDATE SKIP LOCKED;
nothing else does.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from godeye_engine.periodic_lock import acquire, once_per_tick


def _redis(set_returns):
    client = MagicMock()
    client.set.return_value = set_returns
    return client


class TestAcquire:
    def test_the_winner_runs(self):
        with patch("redis.Redis.from_url", return_value=_redis(True)):
            assert acquire("plan-autopilot", 240) is True

    def test_the_loser_stands_down(self):
        """SET NX returns None when the key already exists."""
        with patch("redis.Redis.from_url", return_value=_redis(None)):
            assert acquire("plan-autopilot", 240) is False

    def test_uses_set_nx_with_an_expiry(self):
        """NX is the whole mechanism; the expiry is what stops a crashed holder
        wedging the schedule forever, since the lock is never explicitly
        released."""
        client = _redis(True)
        with patch("redis.Redis.from_url", return_value=client):
            acquire("collect-metrics", 3000)
        _, kwargs = client.set.call_args
        assert kwargs["nx"] is True
        assert kwargs["ex"] == 3000

    def test_namespaced_so_two_tasks_never_share_a_tick(self):
        client = _redis(True)
        with patch("redis.Redis.from_url", return_value=client):
            acquire("plan-autopilot", 10)
            acquire("collect-metrics", 10)
        keys = [call[0][0] for call in client.set.call_args_list]
        assert keys == ["godeye:tick:plan-autopilot", "godeye:tick:collect-metrics"]
        assert len(set(keys)) == 2

    def test_redis_being_down_lets_the_task_RUN(self):
        """The opposite of the rate limiter's choice, on purpose.

        A periodic task that stops when Redis is unavailable is a scheduler that
        quietly does nothing during exactly the incident you need it working
        through -- and these are the tasks that publish posts and refresh
        expiring tokens. Duplicate work needs a second beat to even be possible,
        which is a deployment fault; not running needs only a hiccup.
        """
        with patch("redis.Redis.from_url", side_effect=OSError("connection refused")):
            assert acquire("plan-autopilot", 240) is True


class TestDecorator:
    def test_runs_the_body_when_it_wins(self):
        calls = []

        @once_per_tick("t", 60)
        def work():
            calls.append(1)
            return "done"

        with patch("redis.Redis.from_url", return_value=_redis(True)):
            assert work() == "done"
        assert calls == [1]

    def test_skips_the_body_when_it_loses(self):
        calls = []

        @once_per_tick("t", 60)
        def work():
            calls.append(1)
            return "done"

        with patch("redis.Redis.from_url", return_value=_redis(None)):
            assert work() is None
        # The point: the second scheduler's copy does no work at all.
        assert calls == []

    def test_passes_arguments_through(self):
        @once_per_tick("t", 60)
        def work(a, b=2):
            return a + b

        with patch("redis.Redis.from_url", return_value=_redis(True)):
            assert work(1, b=5) == 6

    def test_keeps_the_wrapped_name(self):
        """Celery registers tasks by name and reads metadata off the function.
        Losing __name__ to a bare wrapper is how a decorator quietly breaks a
        task registry."""

        @once_per_tick("t", 60)
        def plan_autopilot():
            return None

        assert plan_autopilot.__name__ == "plan_autopilot"


class TestWhichTasksAreGuarded:
    """`dispatch_due_posts` is deliberately NOT guarded."""

    def test_dispatch_is_not_locked(self):
        """It claims rows with FOR UPDATE SKIP LOCKED, so a duplicate finds
        nothing and a post still publishes exactly once. It is also the critical
        path: adding a lock whose holder could crash would risk a 30-second gap
        in publishing to prevent a duplicate that cannot happen."""
        import inspect

        from godeye_engine.tasks import scheduler

        source = inspect.getsource(scheduler)
        assert "once_per_tick" not in source

    def test_the_planner_is_locked(self):
        """The one seen running twice in production."""
        import inspect

        from godeye_engine.tasks import planner

        source = inspect.getsource(planner)
        assert 'once_per_tick("plan-autopilot"' in source
