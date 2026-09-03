"""Clearing a channel's error once it publishes again.

A failure stamps the connection with its reason. Nothing removed it, so a
channel that failed once and worked ever after still showed the old error on
Connections, long after the calendar had gone quiet. From the user's side
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
        assert '"ACTIVE"' in source and '"ERROR"' in source

    def test_only_an_errored_connection_is_touched(self):
        """EXPIRED and DISCONNECTED say something about the account rather
        than about this attempt, and a lucky publish must not overwrite them.
        The WHERE is what protects them, so that is what to check, the first
        version of this asserted on a comment and passed either way.
        """
        source = self._finish_source()
        activate = source[source.index('values(status="ACTIVE"') - 300 :]
        assert 'SocialConnection.c.status == "ERROR"' in activate

    def test_publishing_passes_the_connection_through(self):
        """The clearing cannot happen if the caller never says which channel
        it was."""
        # The body, not the task wrapper around it. See _publish_post.
        source = inspect.getsource(scheduler._publish_post)
        assert "connection_id=connection" in source


def test_a_failed_post_never_writes_prose_onto_the_channel():
    """The card says whether the channel works, not what went wrong last time.

    Every permanent failure used to stamp its message onto the connection, so
    the text of a single bad post sat there in red until something later
    happened to clear it, and users disconnected and reconnected to be rid of
    it. The message lives on the post; the card carries status only.
    """
    source = inspect.getsource(scheduler._record_failure)
    assert "lastError=" not in source
    assert "lastErrorAt=" not in source


def test_a_broken_channel_still_changes_status():
    """Dropping the message must not also drop the signal. A credential
    failure has to move the connection out of ACTIVE, or a dead channel looks
    healthy and nobody is told to reconnect."""
    source = inspect.getsource(scheduler._record_failure)
    assert '_is_connection_fault' in source
    assert 'status="ERROR"' in source
