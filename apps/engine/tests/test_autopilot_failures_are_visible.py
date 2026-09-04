"""When autopilot cannot generate, somebody has to be able to tell.

The planner ran every five minutes and kept working: it found slots, dispatched
generation, and advanced each plan. The last post any plan produced was still
eighteen days old. Every plan read "active" the whole time.

Generation was failing, and the failure had nowhere to go. `AgentRun` is
written only after `content_agent.generate` returns, so a failure produced no
run, no content item, no scheduled post -- nothing in the product at all. The
sole trace was a line in a worker log nobody was reading.

What makes it permanent rather than merely invisible: `plan_autopilot` advances
`lastPlannedAt` as soon as it DISPATCHES `autopilot_generate`, not when that
task succeeds. So the slot is spent on failure and never planned again.
Autopilot goes quiet for good while still looking healthy.

Changing the advance-on-dispatch behaviour is a separate change with real
duplicate-post risk, and is not what these tests cover. They cover the part
that makes it diagnosable: a failed generation leaves a FAILED AgentRun naming
the plan and the slot that was lost.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

from godeye_engine.tasks import planner

SLOT = datetime(2026, 9, 5, 9, 0, 0)


class RecordingSession:
    """Captures what was executed so the test can look for the insert."""

    def __init__(self):
        self.statements = []
        self.committed = False

    def execute(self, statement):
        self.statements.append(statement)

        class Result:
            def mappings(self):
                return self

            def first(self):
                return None

            def all(self):
                return []

        return Result()

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


PLAN = {"id": "plan1", "orgId": "org1", "name": "GODEYE"}


def _record(error):
    session = RecordingSession()
    with patch.object(planner, "get_session", return_value=session):
        planner._record_failed_autopilot_run(PLAN, "grow the audience", "AI marketing", SLOT, error)
    return session


def _values(session):
    """The bound values of the single insert that was executed."""
    assert session.statements, "nothing was executed: the failure left no record"
    return session.statements[0].compile().params


class TestTheFailureIsRecorded:
    def test_a_run_is_written_so_the_failure_exists_somewhere(self):
        session = _record(RuntimeError("model refused"))
        assert session.statements
        assert session.committed, "not committed: the row would not survive"

    def test_it_is_marked_failed_and_attributed_to_the_workspace(self):
        values = _values(_record(RuntimeError("model refused")))
        assert values["status"] == "FAILED"
        assert values["orgId"] == "org1"
        assert values["agent"] == "CONTENT"

    def test_the_error_text_survives(self):
        """"Autopilot is broken" costs days. The provider's own message is what
        says whether it is a key, a quota or a bad prompt."""
        values = _values(_record(RuntimeError("insufficient_quota: you exceeded your quota")))
        assert "insufficient_quota" in values["error"]

    def test_an_error_with_no_message_still_says_something(self):
        values = _values(_record(ValueError()))
        assert "ValueError" in values["error"]

    def test_the_lost_slot_is_named(self):
        """The slot is the part that cannot be recovered, because lastPlannedAt
        has already moved past it. Recording it is the only way to know which
        posts were never made."""
        values = _values(_record(RuntimeError("boom")))
        assert values["input"]["slot"] == SLOT.isoformat()
        assert values["input"]["planId"] == "plan1"
        assert values["input"]["autopilot"] is True


class TestItCannotMakeThingsWorse:
    def test_a_database_failure_while_recording_does_not_raise(self):
        """This runs because something already failed. If the database is what
        broke, raising here would replace a generation error with a database
        one and lose the original."""
        with patch.object(planner, "get_session", side_effect=OSError("database is down")):
            planner._record_failed_autopilot_run(
                PLAN, "goal", "topic", SLOT, RuntimeError("the real cause")
            )  # must not raise


class TestItIsWiredIntoTheTask:
    def test_the_generation_except_branch_calls_it(self):
        """Asserted against the source: reaching that branch for real needs a
        plan, a profile, connections and an organisation, which is four fixtures
        to prove one call is present."""
        import inspect

        source = inspect.getsource(planner.autopilot_generate)
        assert "_record_failed_autopilot_run" in source
        # It must not replace the log line: the traceback names the cause, and
        # the row only carries str(e).
        assert "logger.exception" in source
