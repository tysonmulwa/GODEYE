"""Clearing a channel's error once it publishes again.

A failure stamps the connection with its reason. Nothing removed it, so a
channel that failed once and worked ever after still showed the old error on
Connections — long after the calendar had gone quiet. From the user's side
that reads as a channel that is still broken.
"""

from __future__ import annotations

import inspect

from godeye_engine.tasks import scheduler


class TestSuccessClearsTheError:
    def _finish_source(self) -> str:
        """The code without its prose.

        Asserting over the comments is how a test passes because an
        explanation mentions the thing it is meant to forbid.
        """
        return "\n".join(
            line
            for line in inspect.getsource(scheduler._finish).splitlines()
            if not line.strip().startswith("#")
        )

    def test_a_published_post_clears_the_connection_error(self):
        source = self._finish_source()
        assert "lastError=None" in source
        assert "lastErrorAt=None" in source

    def test_only_on_success(self):
        """A failure has just written that error; clearing it in the same
        breath would leave the user with a channel that never explains
        itself."""
        source = self._finish_source()
        guard = source.rindex("if not error", 0, source.index("lastError=None"))
        assert "connection_id" in source[guard : guard + 60]

    def test_an_errored_connection_is_returned_to_active(self):
        """A post going out is proof the connection works, so whatever the
        objection was, it no longer holds."""
        source = self._finish_source()
        assert "case(" in source
        assert '"ERROR"' in source and '"ACTIVE"' in source

    def test_expired_and_disconnected_are_left_alone(self):
        """Those say something about the account rather than about this
        attempt, and a lucky publish should not overwrite them."""
        source = self._finish_source()
        assert "EXPIRED" not in source and "DISCONNECTED" not in source
        # An else_ that keeps the current value is what leaves them untouched.
        assert "else_=SocialConnection.c.status" in source

    def test_publishing_passes_the_connection_through(self):
        """The clearing cannot happen if the caller never says which channel
        it was."""
        source = inspect.getsource(scheduler.publish_post)
        assert "connection_id=connection" in source


def test_the_failure_path_still_records_why():
    """The error has to be written in the first place, or Connections says
    nothing when a channel really is broken."""
    source = inspect.getsource(scheduler._record_failure)
    assert "lastError=" in source and "lastErrorAt=" in source
