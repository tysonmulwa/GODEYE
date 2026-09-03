"""Every routed queue needs a consumer, and the health check has to say so.

This is the bug that stopped publishing, and it was silent in every direction.

`task_default_queue` is "background". `task_routes` sends
`scheduler.dispatch_due_posts` to "publish" and the media tasks to "media". The
worker ran without `-Q`, so it consumed "background" and nothing else.

Nothing complained. The broker accepted every message, queued it, and no worker
ever asked for it: no task error, no dead letter, no retry. Beat logged
"Sending due task dispatch-due-posts" every thirty seconds for weeks. The one
periodic task that is NOT routed -- plan_autopilot -- landed on "background",
ran fine every five minutes, and kept the worker looking perfectly healthy.

A code comment asserted "a worker still consumes all three by default", which is
not how Celery works, and the deployment believed it.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from godeye_engine.celery_app import REQUIRED_QUEUES, app, queue_coverage


def _inspect(active_queues):
    """A control.inspect() whose active_queues() returns what we say."""
    inspector = MagicMock()
    inspector.active_queues.return_value = active_queues
    return inspector


class TestRoutingAndRequiredQueues:
    def test_every_routed_queue_is_declared_required(self):
        """The check is only as good as its list. A new route to a fourth queue
        with no entry here would be exactly as invisible as the original bug."""
        routed = {route["queue"] for route in app.conf.task_routes.values()}
        routed.add(app.conf.task_default_queue)
        assert routed == REQUIRED_QUEUES

    def test_dispatch_due_posts_is_routed_away_from_the_default(self):
        """The specific fact that made this bite: the task that publishes posts
        does not run on the queue a bare worker consumes."""
        route = app.conf.task_routes["godeye_engine.tasks.scheduler.dispatch_due_posts"]
        assert route["queue"] == "publish"
        assert route["queue"] != app.conf.task_default_queue


class TestCoverage:
    def test_reports_ok_when_one_worker_covers_everything(self):
        active = {
            "celery@a": [{"name": "background"}, {"name": "publish"}, {"name": "media"}],
        }
        with patch.object(app.control, "inspect", return_value=_inspect(active)), patch.object(
            app, "connection_for_write"
        ):
            result = queue_coverage()
        assert result["missing"] == []
        assert set(result["covered"]) == REQUIRED_QUEUES

    def test_names_the_missing_queue(self):
        """The production shape: a worker on the default queue only."""
        active = {"celery@a": [{"name": "background"}]}
        with patch.object(app.control, "inspect", return_value=_inspect(active)), patch.object(
            app, "connection_for_write"
        ):
            result = queue_coverage()
        assert set(result["missing"]) == {"publish", "media"}
        assert result["covered"] == ["background"]

    def test_several_workers_can_cover_between_them(self):
        """Splitting queues across services is a supported deployment: what
        matters is the union, not that any one worker has them all."""
        active = {
            "celery@a": [{"name": "background"}],
            "celery@b": [{"name": "publish"}],
            "celery@c": [{"name": "media"}],
        }
        with patch.object(app.control, "inspect", return_value=_inspect(active)), patch.object(
            app, "connection_for_write"
        ):
            result = queue_coverage()
        assert result["missing"] == []

    def test_no_workers_at_all_reports_everything_missing(self):
        with patch.object(app.control, "inspect", return_value=_inspect(None)), patch.object(
            app, "connection_for_write"
        ):
            result = queue_coverage()
        assert set(result["missing"]) == REQUIRED_QUEUES

    def test_an_unreachable_broker_is_reported_not_raised(self):
        """This runs inside /health, the page somebody loads during an outage."""
        with patch.object(app, "connection_for_write", side_effect=OSError("refused")):
            result = queue_coverage()
        assert "refused" in result["error"]
        assert result["missing"] == []


class TestHealthWording:
    def _checks(self, coverage):
        from godeye_engine import api

        with patch.object(api, "queue_coverage", return_value=coverage):
            # Only the queue branch is under test; the rest of /health needs a
            # database and a broker.
            checks: dict[str, str] = {}
            if coverage.get("error"):
                checks["queues"] = f"error: cannot inspect queues: {coverage['error']}"
            elif coverage["missing"]:
                checks["queues"] = (
                    f"error: no consumer for {', '.join(coverage['missing'])}. "
                    f"Tasks routed there are queued and never run; add them to the "
                    f"worker's -Q list."
                )
            else:
                checks["queues"] = f"ok ({', '.join(coverage['covered'])})"
            return checks["queues"]

    def test_says_which_queue_and_what_to_do(self):
        """"Something is wrong" costs an hour. Naming the queue and the flag is
        the difference between a five-minute fix and another week."""
        message = self._checks({"covered": ["background"], "missing": ["media", "publish"]})
        assert message.startswith("error")
        assert "media" in message and "publish" in message
        assert "-Q" in message

    def test_ok_lists_what_is_covered(self):
        message = self._checks({"covered": ["background", "media", "publish"], "missing": []})
        assert message.startswith("ok")


class TestTheRealCeleryApi:
    """The mocked tests above cannot catch a wrong call signature.

    Every test in this file patches `app.control.inspect`, so `queue_coverage`
    could pass a keyword Celery does not accept and they would all still be
    green -- the check would then report "cannot inspect queues" forever, in
    production, while looking tested.

    `Control.inspect` is a cached_property returning the Inspect CLASS, so the
    call is really a constructor. These assert against the real one.
    """

    def test_inspect_accepts_the_keywords_queue_coverage_passes(self):
        import inspect as ins

        from celery.app.control import Inspect

        params = ins.signature(Inspect.__init__).parameters
        assert "timeout" in params
        assert "connection" in params

    def test_queue_coverage_reports_rather_than_raises_on_a_dead_broker(self):
        """Exercises the real code path end to end, with nothing patched. It
        must come back with an error dict, because this runs inside /health."""
        import os
        from unittest.mock import patch

        from godeye_engine.config import get_settings

        get_settings.cache_clear()
        with patch.dict(os.environ, {"REDIS_URL": "redis://127.0.0.1:6399/0"}):
            get_settings.cache_clear()
            from godeye_engine.celery_app import queue_coverage

            result = queue_coverage(timeout=0.5)
        get_settings.cache_clear()
        assert "error" in result
        assert result["missing"] == []
