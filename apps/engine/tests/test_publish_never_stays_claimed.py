"""A post that cannot be published must not sit in PROCESSING forever.

Every post on the calendar showed "processing" and none of them moved. They had
been claimed -- so beat, the broker and the worker were all fine -- and then
something in `publish_post` raised before it reached the part that classifies
failures.

Everything from the credential decrypt onwards was already guarded: it records
the reason, the post shows it, the connection is flagged if it is at fault.
Everything before it was not: the row reads, attaching a catalogue photo,
building the payload. An exception there escaped with the row still PROCESSING
and lockedAt set.

Nothing resolved that. LOCK_TIMEOUT_MINUTES later the stale-lock branch of
due_posts_query re-claimed the row, dispatched it, and it failed in the same
place again. Forever. No error on the post, no FAILED state, nothing in the
product to look at -- just a traceback in the worker log, and a calendar that
looked like work in progress.

The rule these tests hold: whatever happens, publish_post does not return the
post to the pool still claimed and still silent.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from godeye_engine.tasks import scheduler
from godeye_engine.tasks.scheduler import MAX_ATTEMPTS, publish_post


def _post(status="PROCESSING", attempts=0):
    return {
        "id": "sp1",
        "orgId": "org1",
        "connectionId": "conn1",
        "contentItemId": "ci1",
        "status": status,
        "attempts": attempts,
    }


class OneRowSession:
    """Answers every read with the same post."""

    def __init__(self, post):
        self.post = post

    def execute(self, statement):
        post = self.post

        class Result:
            def mappings(self):
                return self

            def first(self):
                return post

        return Result()

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _run_with_failure(error, post):
    """publish_post where the guarded inner body raises `error`."""
    with (
        patch.object(scheduler, "_publish_post", side_effect=error),
        patch.object(scheduler, "get_session", return_value=OneRowSession(post)),
        patch.object(scheduler, "_record_failure") as record,
    ):
        with pytest.raises(type(error)):
            publish_post("sp1")
    return record


class TestAnUnclassifiedErrorIsRecorded:
    def test_the_post_does_not_stay_processing(self):
        """The bug, stated directly."""
        record = _run_with_failure(RuntimeError("boom"), _post())
        assert record.called, "nothing recorded: the row is still PROCESSING and will re-claim"

    def test_the_reason_is_carried_onto_the_post(self):
        """Silence is what made this cost a day. The message has to survive."""
        record = _run_with_failure(RuntimeError("column does not exist"), _post())
        assert "column does not exist" in record.call_args.args[3]

    def test_an_error_with_no_message_still_says_something(self):
        """Some exceptions stringify to "". Recording that is recording
        nothing, which is the state we are trying to get out of."""
        record = _run_with_failure(ValueError(), _post())
        assert "ValueError" in record.call_args.args[3]

    def test_a_first_failure_is_transient_so_it_retries(self):
        record = _run_with_failure(RuntimeError("blip"), _post(attempts=0))
        assert record.call_args.kwargs["permanent"] is False

    def test_it_gives_up_at_the_attempt_limit(self):
        """Retrying forever is the loop wearing a different hat."""
        record = _run_with_failure(RuntimeError("nope"), _post(attempts=MAX_ATTEMPTS))
        assert record.call_args.kwargs["permanent"] is True

    def test_the_original_error_still_reaches_the_worker_log(self):
        """Re-raised on purpose: the traceback is what names the cause, and
        swallowing it here would trade one silent failure for another."""
        with (
            patch.object(scheduler, "_publish_post", side_effect=RuntimeError("the real cause")),
            patch.object(scheduler, "get_session", return_value=OneRowSession(_post())),
            patch.object(scheduler, "_record_failure"),
        ):
            with pytest.raises(RuntimeError, match="the real cause"):
                publish_post("sp1")


class TestItDoesNotOverwriteARealOutcome:
    def test_a_post_already_resolved_is_left_alone(self):
        """The task can raise after the post reached a terminal state. Stamping
        FAILED over a published post would be worse than the loop."""
        record = _run_with_failure(RuntimeError("late boom"), _post(status="PUBLISHED"))
        assert not record.called

    def test_a_missing_post_is_not_invented(self):
        with (
            patch.object(scheduler, "_publish_post", side_effect=RuntimeError("boom")),
            patch.object(scheduler, "get_session", return_value=OneRowSession(None)),
            patch.object(scheduler, "_record_failure") as record,
        ):
            with pytest.raises(RuntimeError):
                publish_post("sp1")
        assert not record.called


class TestTheGuardCannotMakeThingsWorse:
    def test_a_failure_while_recording_does_not_mask_the_original(self):
        """This runs because something already broke. If the database is the
        thing that broke, the recorder breaks too -- and the original traceback
        is still the one worth having."""
        with (
            patch.object(scheduler, "_publish_post", side_effect=RuntimeError("the real cause")),
            patch.object(scheduler, "get_session", side_effect=OSError("database is down")),
        ):
            with pytest.raises(RuntimeError, match="the real cause"):
                publish_post("sp1")

    def test_the_wrapper_passes_a_normal_result_through(self):
        with patch.object(scheduler, "_publish_post", return_value={"status": "PUBLISHED"}):
            assert publish_post("sp1") == {"status": "PUBLISHED"}

    def test_a_stood_down_copy_is_not_recorded_as_a_failure(self):
        """`superseded` and `skipped` are normal returns, not errors."""
        with patch.object(scheduler, "_publish_post", return_value={"status": "superseded"}):
            assert publish_post("sp1") == {"status": "superseded"}


class TestTheRealPathNotJustTheWrapper:
    """Drives `publish_post` for real, with nothing about the guard patched.

    The tests above patch `_publish_post`, which only exists because of the
    fix, so on the parent commit they fail by AttributeError rather than by
    observing the behaviour. This one makes the database fail partway through
    the reads -- one of the several unguarded steps that ran before the publish
    attempt -- and asserts the outcome, so it is RED on the parent for the
    reason that matters.
    """

    class _FailsOnTheSecondRead:
        """Returns the claimed post, then loses the connection."""

        def __init__(self, post):
            self.post = post
            self.reads = 0

        def execute(self, statement):
            self.reads += 1
            if self.reads > 1:
                raise OSError('column "somethingNew" does not exist')
            post = self.post

            class Result:
                def mappings(self):
                    return self

                def first(self):
                    return post

            return Result()

        def commit(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def test_a_read_failure_marks_the_post_rather_than_leaving_it_claimed(self):
        post = _post()
        # First session: the publish attempt, which breaks partway through.
        # Second: the one the guard opens to record what happened.
        sessions = [self._FailsOnTheSecondRead(post), OneRowSession(post)]
        with (
            patch.object(scheduler, "get_session", side_effect=sessions),
            patch.object(scheduler, "_record_failure") as record,
        ):
            with pytest.raises(OSError):
                publish_post("sp1")

        assert record.called, (
            "the post is still PROCESSING with no error recorded; the stale-lock "
            "check will re-claim it and it will fail here again, forever"
        )
        assert "somethingNew" in record.call_args.args[3]
