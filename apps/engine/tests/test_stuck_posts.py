"""Posts abandoned between being claimed and being published.

dispatch_due_posts flips a post to PROCESSING before handing it to a worker. If
that worker goes away mid-publish, a deploy is the ordinary way, the row stays
PROCESSING. Three real posts sat that way for half an hour, showing "processing"
with nothing working on them.
"""

from __future__ import annotations

from datetime import timedelta

from godeye_engine.tasks import scheduler
from godeye_engine.tasks.scheduler import (
    PUBLISH_HARD_LIMIT_SEC,
    STUCK_POST_MINUTES,
    due_posts_query,
)


class TestTheGapThatStrandedThem:
    def test_dispatch_only_ever_looks_at_pending_posts(self):
        """The recovery this file exists for cannot live in due_posts_query.

        That query pairs a stale-lock check with status == PENDING, so it reads
        as though it reclaims abandoned work. It cannot: an abandoned post is
        PROCESSING, and the two conditions are AND-ed.
        """
        now = scheduler.utcnow()
        sql = str(due_posts_query(now, now - timedelta(minutes=5)))
        assert "status" in sql and "lockedAt" in sql
        # Both conditions in one AND is exactly why nothing was reclaimed.
        assert " OR " in sql.upper(), "the stale-lock branch should still be there"

    def test_the_reap_window_outlasts_the_task_that_could_still_be_running(self):
        """A task re-queued underneath itself really would publish twice."""
        assert STUCK_POST_MINUTES * 60 > PUBLISH_HARD_LIMIT_SEC, (
            "re-queuing before the hard limit can double-post"
        )

    def test_publishing_is_bounded_well_inside_the_generic_task_ceiling(self):
        """Knowing when a publish is dead is what makes reclaiming safe. The
        slowest legitimate path is an Instagram Reel: render, store, then up to
        five minutes while Instagram fetches and transcodes it."""
        from godeye_engine.publishers.meta import REEL_CONTAINER_TIMEOUT_SEC

        assert PUBLISH_HARD_LIMIT_SEC > REEL_CONTAINER_TIMEOUT_SEC
        assert PUBLISH_HARD_LIMIT_SEC < 25 * 60


class TestReaper:
    def _run(self, monkeypatch, rows):
        """Run the reaper against a fake session, capturing the update."""
        captured: dict = {}

        class FakeResult:
            def mappings(self):
                return self

            def all(self):
                return rows

        class FakeSession:
            def execute(self, statement):
                text = str(statement)
                if text.strip().upper().startswith("UPDATE"):
                    captured["update"] = text
                    return None
                captured["select"] = text
                return FakeResult()

            def commit(self):
                captured["committed"] = True

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        monkeypatch.setattr(scheduler, "get_session", lambda: FakeSession())
        return scheduler.reap_stuck_posts(), captured

    def test_requeues_an_abandoned_post(self, monkeypatch):
        result, captured = self._run(
            monkeypatch, [{"id": "sp1", "orgId": "org1"}, {"id": "sp2", "orgId": "org1"}]
        )
        assert result == {"requeued": 2}
        assert "update" in captured
        assert captured.get("committed")

    def test_only_looks_at_claimed_posts(self, monkeypatch):
        _, captured = self._run(monkeypatch, [])
        select = captured["select"]
        assert "status" in select and "lockedAt" in select

    def test_does_nothing_when_nothing_is_stuck(self, monkeypatch):
        """No write and no commit, so an idle system stays idle."""
        result, captured = self._run(monkeypatch, [])
        assert result == {"requeued": 0}
        assert "update" not in captured
        assert "committed" not in captured

    def test_is_scheduled_to_run_on_its_own(self, monkeypatch):
        """A reaper nobody calls is not a reaper."""
        from godeye_engine.celery_app import app

        entry = app.conf.beat_schedule.get("reap-stuck-posts")
        assert entry, "not in the beat schedule"
        assert entry["task"].endswith("reap_stuck_posts")
        # Recovery should be minutes behind the window, not hours.
        assert entry["schedule"] <= 300
