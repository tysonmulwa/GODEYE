"""A due post waits for an image that is still being made.

Autopilot writes the post and queues its image as two separate jobs. When the
image was slower than the slot, the post went out anyway: bare text on
Facebook, and on Instagram an outright failure reading "Instagram requires an
image or video", from the same content item minutes apart. Neither is
recoverable afterwards. A published post cannot grow an image, and retrying a
failed one finds the same nothing, which is why rescheduling kept failing
identically.
"""

from datetime import timedelta

from godeye_engine.tasks.scheduler import IMAGE_WAIT_MINUTES, should_wait_for_image


def never():
    raise AssertionError("the database was asked before the cheap checks passed")


class TestShouldWaitForImage:
    def test_waits_when_an_image_is_on_its_way(self):
        assert should_wait_for_image(
            has_media=False, overdue=timedelta(seconds=30), image_coming=lambda: True
        )

    def test_a_post_that_has_media_goes_out_now(self):
        assert not should_wait_for_image(
            has_media=True, overdue=timedelta(seconds=30), image_coming=never
        )

    def test_no_image_in_flight_means_no_reason_to_wait(self):
        """Waiting for nothing would stall the slot for the full deadline and
        then publish exactly the same post."""
        assert not should_wait_for_image(
            has_media=False, overdue=timedelta(seconds=30), image_coming=lambda: False
        )

    def test_the_wait_is_bounded(self):
        """An image that never arrives must not hold the slot forever. Past the
        deadline the post goes out plain, which beats never going out."""
        assert not should_wait_for_image(
            has_media=False,
            overdue=timedelta(minutes=IMAGE_WAIT_MINUTES + 1),
            image_coming=lambda: True,
        )

    def test_the_boundary_itself_does_not_wait(self):
        assert not should_wait_for_image(
            has_media=False,
            overdue=timedelta(minutes=IMAGE_WAIT_MINUTES),
            image_coming=lambda: True,
        )

    def test_a_video_counts_as_media(self):
        """Slideshow posts carry a video and no image, and must not be held."""
        assert not should_wait_for_image(
            has_media=True, overdue=timedelta(0), image_coming=never
        )

    def test_the_database_is_only_asked_when_it_matters(self):
        """image_coming is a query. Calling it for a post that already has
        media would be one round trip per publish for no reason."""
        should_wait_for_image(has_media=True, overdue=timedelta(0), image_coming=never)
        should_wait_for_image(
            has_media=False,
            overdue=timedelta(minutes=IMAGE_WAIT_MINUTES + 5),
            image_coming=never,
        )


class TestTheQueryCompiles:
    """The predicate reads a JSONB field. A wrong column name here would only
    surface in production, because a Celery task body does not run at import,
    which is exactly how a reference to a column that does not exist once
    stopped all image generation with the whole suite green."""

    def test_the_pending_image_lookup_is_valid_sql(self):
        from sqlalchemy import select
        from sqlalchemy.dialects import postgresql

        from godeye_engine.db import AgentRun

        compiled = str(
            select(AgentRun.c.id)
            .where(
                AgentRun.c.agent == "IMAGE",
                AgentRun.c.status.in_(["QUEUED", "RUNNING"]),
                AgentRun.c.input["contentItemId"].astext == "abc",
            )
            .compile(dialect=postgresql.dialect())
        )
        assert "input ->>" in compiled
