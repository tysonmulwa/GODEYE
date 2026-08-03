"""Not publishing the same post twice.

A real product went out twice, thirteen minutes apart. PROCESSING is written
when dispatch claims a row, not when a worker starts the task — and the worker
runs two at a time, so a post can sit in the queue behind others while already
marked as being worked on. The reaper read that wait as abandonment, re-queued
it, and both copies of the task found PROCESSING and published.
"""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta

from godeye_engine.tasks import scheduler
from godeye_engine.tasks.scheduler import (
    PUBLISH_HARD_LIMIT_SEC,
    STUCK_POST_MINUTES,
    publish_post,
)

CLAIMED = datetime(2026, 8, 3, 13, 0, 0)


class FakeSession:
    """Answers the first query with the post, then nothing.

    Enough to reach the claim check and one step past it: a task that gets
    through finds no content and stops there, which is all these tests need to
    tell "stood down" from "carried on".
    """

    def __init__(self, post):
        self.post = post
        self.calls = 0

    def execute(self, statement):
        self.calls += 1
        row = self.post if self.calls == 1 else None

        class Result:
            def mappings(self):
                return self

            def first(self):
                return row

            def fetchall(self):
                return []

            def scalar(self):
                return None

        return Result()

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _post(locked_at):
    return {
        "id": "sp1",
        "orgId": "org1",
        "status": "PROCESSING",
        "lockedAt": locked_at,
        "contentItemId": "c1",
        "connectionId": "conn1",
        "attempts": 0,
    }


class TestTheClaimSurvivesTheDatabase:
    """The check has to hold for values the database can actually return.

    lockedAt is TIMESTAMP(3) and utcnow() carries microseconds, so a claim
    dispatched at .885898 comes back as .885000. Compared with ==, that is
    every task deciding it had been superseded by itself — publishing stopped
    entirely, and the first version of these tests missed it because they used
    a whole-second timestamp Postgres would never have altered.
    """

    def test_a_claim_truncated_to_milliseconds_still_matches(self, monkeypatch):
        dispatched = datetime(2026, 8, 3, 15, 47, 46, 885898)
        stored = dispatched.replace(microsecond=885000)  # what Postgres keeps
        monkeypatch.setattr(scheduler, "get_session", lambda: FakeSession(_post(stored)))
        result = publish_post("sp1", claimed_at=dispatched.isoformat())
        assert result.get("status") != "superseded"

    def test_a_genuinely_newer_claim_is_still_caught(self, monkeypatch):
        """The tolerance must not be so loose it stops catching the thing it
        is for. A re-claim is minutes away."""
        dispatched = datetime(2026, 8, 3, 15, 47, 46, 885898)
        requeued = dispatched + timedelta(minutes=30)
        monkeypatch.setattr(scheduler, "get_session", lambda: FakeSession(_post(requeued)))
        assert publish_post("sp1", claimed_at=dispatched.isoformat()) == {"status": "superseded"}

    def test_the_tolerance_is_far_below_the_reap_window(self):
        from godeye_engine.tasks.scheduler import CLAIM_TOLERANCE_SEC

        assert CLAIM_TOLERANCE_SEC < STUCK_POST_MINUTES * 60 / 100


class TestAStaleTaskStandsDown:
    def test_a_task_from_a_superseded_claim_does_not_publish(self, monkeypatch):
        """The post was re-queued and re-claimed while this copy waited. Its
        claim time no longer matches, so it is not the one that owns it."""
        monkeypatch.setattr(
            scheduler, "get_session", lambda: FakeSession(_post(CLAIMED + timedelta(minutes=27)))
        )
        result = publish_post("sp1", claimed_at=CLAIMED.isoformat())
        assert result == {"status": "superseded"}

    def test_the_current_claim_proceeds(self, monkeypatch):
        """Matching claim: this really is the task that owns the post, so it
        must get past the check rather than stalling everything."""
        monkeypatch.setattr(scheduler, "get_session", lambda: FakeSession(_post(CLAIMED)))
        result = publish_post("sp1", claimed_at=CLAIMED.isoformat())
        assert result.get("status") != "superseded"

    def test_a_task_with_no_claim_still_runs(self, monkeypatch):
        """Messages queued before this change carry no claim time, and must
        not be stranded by it."""
        monkeypatch.setattr(scheduler, "get_session", lambda: FakeSession(_post(CLAIMED)))
        assert publish_post("sp1").get("status") != "superseded"

    def test_a_post_no_longer_processing_is_skipped_as_before(self, monkeypatch):
        published = {**_post(CLAIMED), "status": "PUBLISHED"}
        monkeypatch.setattr(scheduler, "get_session", lambda: FakeSession(published))
        assert publish_post("sp1", claimed_at=CLAIMED.isoformat()) == {"status": "skipped"}


class TestTheClaimTravelsWithTheTask:
    def test_dispatch_sends_the_claim_time(self):
        """Without it the task cannot tell whether it is still the owner."""
        source = inspect.getsource(scheduler.dispatch_due_posts)
        assert "claimed_at=" in source
        # The same instant that was written to lockedAt, not a fresh now().
        assert "lockedAt=now" in source and "claimed_at=now.isoformat()" in source


class TestTheAbandonmentWindow:
    def test_it_allows_for_queue_time_not_just_run_time(self):
        """Twelve minutes was sized against the task's own hard limit, which
        assumed a claimed post is a running one. It is not."""
        assert STUCK_POST_MINUTES * 60 >= 2 * PUBLISH_HARD_LIMIT_SEC

    def test_a_lost_post_is_still_recovered_within_the_hour(self):
        """The window may be generous, but a post nobody is working on has to
        come back on its own."""
        assert STUCK_POST_MINUTES <= 60
