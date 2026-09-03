"""Autopilot reaching for imported photographs when it generates none.

A workspace that imported its catalogue owns real pictures of what it sells.
Without one an autopilot post is bare text, and TikTok and Instagram both
refuse that outright, so this is the difference between a post and no post,
not between a better image and a worse one.
"""

from __future__ import annotations

from datetime import datetime

from godeye_engine.tasks import planner, products
from godeye_engine.tasks.products import attach_imported_photo

NOW = datetime(2026, 8, 3, 9, 0, 0)


class FakeSession:
    def __init__(self, product):
        self.product = product
        self.inserts: list[dict] = []
        self.updates: list[dict] = []
        self.committed = False

    def execute(self, statement):
        # By type, not by stringifying: these statements carry Prisma-owned
        # enum columns whose bind expressions need a dialect to render.
        kind = type(statement).__name__
        session = self

        class Result:
            def mappings(self):
                return self

            def first(self):
                return session.product

        if kind == "Insert":
            self.inserts.append(dict(statement.compile().params))
            return None
        if kind == "Update":
            self.updates.append(dict(statement.compile().params))
            return None
        self.last_select = statement
        return Result()

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _run(monkeypatch, product):
    session = FakeSession(product)
    monkeypatch.setattr(products, "get_session", lambda: session)
    return attach_imported_photo("org1", "content1", NOW), session


PRODUCT = {"id": "p1", "imageUrl": "https://cdn/boot.jpg", "postCount": 2}


def test_attaches_an_imported_photo(monkeypatch):
    attached, session = _run(monkeypatch, PRODUCT)
    assert attached is True
    assert len(session.inserts) == 1
    row = session.inserts[0]
    assert row["url"] == "https://cdn/boot.jpg"
    assert row["kind"] == "IMAGE"
    assert row["contentItemId"] == "content1"
    assert session.committed


def test_the_row_satisfies_the_columns_the_table_requires(monkeypatch):
    """storageKey and mimeType are NOT NULL and there is no updatedAt. The
    first version of this insert had all three wrong, and only a compile
    against the real table caught it, the shape of a row is not something to
    take on trust."""
    _, session = _run(monkeypatch, PRODUCT)
    row = session.inserts[0]
    assert row["storageKey"], "NOT NULL, and the shop hosts the file"
    assert row["mimeType"], "NOT NULL"
    assert "updatedAt" not in row, "the table has no such column"
    # Imported, not uploaded: nobody put this file here.
    assert row["source"] == "IMPORTED"


def test_a_workspace_with_no_catalogue_carries_on_without_one(monkeypatch):
    """No products is the ordinary case for most workspaces, not a failure."""
    attached, session = _run(monkeypatch, None)
    assert attached is False
    assert session.inserts == []
    assert not session.committed


def test_the_photo_is_counted_as_used(monkeypatch):
    """Otherwise a run of posts shows the same picture every time."""
    _, session = _run(monkeypatch, PRODUCT)
    assert len(session.updates) == 1
    assert 3 in session.updates[0].values(), session.updates[0]


class TestWhichPhotoIsChosen:
    def _select(self, monkeypatch):
        _, session = _run(monkeypatch, PRODUCT)
        # The columns and ordering the query names, without rendering SQL.
        statement = session.last_select
        where = statement.whereclause
        return {
            # The literal lives in the bind parameters, not the SQL text.
            "columns": str(where),
            "values": list(where.compile().params.values()),
            "order": [str(c) for c in statement._order_by_clauses],
        }

    def test_products_with_no_photograph_are_not_considered(self, monkeypatch):
        assert "imageUrl" in self._select(monkeypatch)["columns"]

    def test_out_of_stock_products_are_skipped(self, monkeypatch):
        """Showing something unbuyable is worse than showing nothing."""
        assert "OutOfStock" in self._select(monkeypatch)["values"]

    def test_the_least_used_photograph_comes_first(self, monkeypatch):
        order = self._select(monkeypatch)["order"]
        assert order and "postCount" in order[0]


class TestRetryingAFailedPost:
    """Real posts failed with "needs media", were rescheduled, and failed
    identically, because a retry re-queues the same content, and that content
    still has nothing attached. Nothing about retrying could ever fix it."""

    def _publish_source(self):
        import inspect

        from godeye_engine.tasks import scheduler

        # `_publish_post` is the body; `publish_post` is the thin task
        # wrapper that records an unclassified failure so a post cannot be
        # left claimed. The logic these tests read lives in the body.
        return inspect.getsource(scheduler._publish_post)

    def test_a_post_with_no_media_borrows_one_before_giving_up(self):
        source = self._publish_source()
        assert "attach_imported_photo" in source
        # After the media lists are built, so it only fires when they are empty.
        assert source.index("media_urls = [") < source.index("attach_imported_photo")

    def test_only_for_networks_that_refuse_a_text_post(self):
        """Elsewhere text alone is a legitimate post; borrowing a photograph
        would change what the user wrote."""
        from godeye_engine.tasks.scheduler import MEDIA_REQUIRED_PLATFORMS

        assert set(MEDIA_REQUIRED_PLATFORMS) == {"TIKTOK", "INSTAGRAM"}
        assert "MEDIA_REQUIRED_PLATFORMS" in self._publish_source()

    def test_a_post_that_already_has_media_is_left_alone(self):
        source = self._publish_source()
        guard = source[source.index("MEDIA_REQUIRED_PLATFORMS") :][:200]
        assert "not media_urls" in guard and "not video_urls" in guard


class TestWiring:
    def test_generated_images_still_win_when_they_are_switched_on(self):
        """The fallback is for when nothing is being generated, not instead."""
        import inspect

        source = inspect.getsource(planner.autopilot_generate)
        generate_at = source.index("_queue_image_for_content")
        fallback_at = source.index("attach_imported_photo")
        assert generate_at < fallback_at
        assert "else:" in source[generate_at:fallback_at]
