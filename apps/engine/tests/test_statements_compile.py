"""Every write the scheduler makes, compiled against the real tables.

Twice now a statement named a column its SQLAlchemy table did not define, and
both times it shipped. SQLAlchemy does not ignore an unknown name — it raises
CompileError — so the failure lands wherever that statement runs.

The worst one was in _finish. The post published, then recording it raised,
the transaction rolled back, and task_acks_late redelivered the message. The
post published again. And again. From outside that looked like duplicate
posts, a status stuck on PROCESSING, and connection errors that never
cleared — none of which pointed at a mistyped column name.

Compiling is enough to catch it and needs no database. Every test here would
have failed on the code that shipped.
"""

from __future__ import annotations

import pytest
from sqlalchemy import update
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import CompileError

from godeye_engine.db import (
    ContentItem,
    MediaAsset,
    Product,
    ScheduledPost,
    SocialConnection,
    new_id,
    utcnow,
)

NOW = utcnow()


def compiles(statement) -> str:
    """Render for Postgres, or fail with the column that does not exist."""
    return str(statement.compile(dialect=postgresql.dialect()))


class TestFinishWritesTheRowsItNames:
    """_finish runs after a post is already live, so anything that raises here
    costs a duplicate rather than a failed post."""

    def test_marking_the_post_published(self):
        compiles(
            update(ScheduledPost)
            .where(ScheduledPost.c.id == "sp1")
            .values(
                status="PUBLISHED", error=None, publishedAt=NOW, externalPostId="x",
                externalPostUrl="u", lockedAt=None, updatedAt=NOW,
            )
        )

    def test_marking_the_content_published(self):
        compiles(
            update(ContentItem)
            .where(ContentItem.c.id == "c1")
            .values(status="PUBLISHED", updatedAt=NOW)
        )

    def test_clearing_the_connection_error(self):
        """The one that shipped broken: lastCheckedAt and updatedAt exist in
        the database but were not mapped on the table."""
        compiles(
            update(SocialConnection)
            .where(SocialConnection.c.id == "conn1")
            .values(lastError=None, lastErrorAt=None, lastCheckedAt=NOW, updatedAt=NOW)
        )

    def test_returning_an_errored_connection_to_active(self):
        compiles(
            update(SocialConnection)
            .where(SocialConnection.c.id == "conn1", SocialConnection.c.status == "ERROR")
            .values(status="ACTIVE", updatedAt=NOW)
        )

    def test_recording_a_failure_on_the_connection(self):
        compiles(
            update(SocialConnection)
            .where(SocialConnection.c.id == "conn1")
            .values(lastError="boom", lastErrorAt=NOW)
        )


class TestTheOtherWritesAroundPublishing:
    def test_claiming_due_posts(self):
        compiles(
            update(ScheduledPost)
            .where(ScheduledPost.c.id.in_(["a", "b"]))
            .values(status="PROCESSING", lockedAt=NOW, updatedAt=NOW)
        )

    def test_requeuing_an_abandoned_post(self):
        compiles(
            update(ScheduledPost)
            .where(ScheduledPost.c.id.in_(["a"]))
            .values(status="PENDING", lockedAt=None, updatedAt=NOW)
        )

    def test_attaching_a_borrowed_photograph(self):
        """The first bug of this shape: an updatedAt MediaAsset does not have,
        and two NOT NULL columns left out."""
        compiles(
            MediaAsset.insert().values(
                id=new_id(), orgId="org1", contentItemId="c1", kind="IMAGE",
                source="IMPORTED", storageKey="https://cdn/x.jpg",
                url="https://cdn/x.jpg", mimeType="image/jpeg", createdAt=NOW,
            )
        )

    def test_counting_a_product_as_used(self):
        compiles(
            update(Product).where(Product.c.id == "p1").values(postCount=1, updatedAt=NOW)
        )


def test_an_unmapped_column_really_does_raise():
    """The premise. If SQLAlchemy quietly dropped unknown names these tests
    would prove nothing, and the real bug would have been something else."""
    with pytest.raises(CompileError):
        compiles(
            update(SocialConnection)
            .where(SocialConnection.c.id == "conn1")
            .values(noSuchColumn="x")
        )
