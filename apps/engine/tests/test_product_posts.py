"""Choosing which product to post about, and scheduling it.

The choosing is the feature. Emptying a forty-product catalogue into a feed is
a bulk uploader, not marketing.
"""

from __future__ import annotations

from godeye_engine.celery_app import app
from godeye_engine.tasks import product_posts
from godeye_engine.tasks.product_posts import REPOST_AFTER_DAYS, SCHEDULE_AHEAD_MINUTES


class TestSelectionRules:
    """Asserted against the query the task actually issues, so the intent and
    the SQL cannot drift apart."""

    def _query(self):
        import inspect

        return inspect.getsource(product_posts.create_product_post)

    def test_never_posted_products_come_first(self):
        """A new arrival is the thing worth announcing."""
        source = self._query()
        assert "nullsfirst" in source
        assert "lastPostedAt" in source

    def test_out_of_stock_products_are_skipped(self):
        """Sending people to something they cannot buy wastes the post."""
        assert "OutOfStock" in self._query()

    def test_a_product_is_not_repeated_immediately(self):
        assert REPOST_AFTER_DAYS >= 7, "a small catalogue would read as a loop"

    def test_the_post_is_scheduled_ahead_not_published_instantly(self):
        """A window on the calendar is the chance to cancel before it goes."""
        assert SCHEDULE_AHEAD_MINUTES >= 15


class TestTheRowsItWrites:
    """Compiled against the real tables. Source-inspection tests missed that
    this insert named a column the table does not have and omitted two it
    requires, it would have failed on the first auto-post."""

    def test_the_media_row_matches_the_table(self):
        from godeye_engine.db import MediaAsset

        statement = MediaAsset.insert().values(
            id="m1", orgId="org1", contentItemId="c1", kind="IMAGE",
            source="IMPORTED", storageKey="https://cdn/x.jpg",
            url="https://cdn/x.jpg", mimeType="image/jpeg",
            createdAt=scheduler_now(),
        )
        params = statement.compile().params
        assert params["storageKey"] and params["mimeType"]
        assert "updatedAt" not in params

    def test_the_task_uses_that_same_shape(self):
        import inspect

        source = inspect.getsource(product_posts.create_product_post)
        media = source[source.index("MediaAsset.insert") : source.index("for connection")]
        assert "storageKey=" in media and "mimeType=" in media
        assert "updatedAt=" not in media
        assert 'source="IMPORTED"' in media


def scheduler_now():
    from godeye_engine.db import utcnow

    return utcnow()


class TestScheduling:
    def test_both_jobs_are_in_the_beat_schedule(self):
        """A task nobody calls is not automation."""
        for name, task in (
            ("scheduled-product-imports", "products.scheduled_imports"),
            ("plan-product-posts", "product_posts.plan_product_posts"),
        ):
            entry = app.conf.beat_schedule.get(name)
            assert entry, f"{name} is not scheduled"
            assert entry["task"].endswith(task)

    def test_posting_is_not_more_frequent_than_importing_is_useful(self):
        """A catalogue is not news; posting from it hourly would exhaust a
        small shop's products in a week."""
        posts = app.conf.beat_schedule["plan-product-posts"]["schedule"]
        assert posts >= 6 * 3600

    def test_importing_does_not_hammer_a_customer_site(self):
        imports = app.conf.beat_schedule["scheduled-product-imports"]["schedule"]
        assert imports >= 3600


class TestConsentIsStillRequired:
    """Auto-post reads from a catalogue that only exists because someone
    allowed it, and that permission can be withdrawn."""

    def test_planning_requires_consent_and_auto_post(self):
        import inspect

        source = inspect.getsource(product_posts.plan_product_posts)
        assert "productAutoPost" in source
        assert "productImportConsentAt" in source

    def test_scheduled_imports_require_consent_and_auto_import(self):
        import inspect

        from godeye_engine.tasks import products

        source = inspect.getsource(products.scheduled_imports)
        assert "productAutoImport" in source
        assert "productImportConsentAt" in source

    def test_a_workspace_with_no_destinations_is_skipped(self):
        import inspect

        source = inspect.getsource(product_posts.plan_product_posts)
        # The settings refuse this combination, but a row could predate them.
        assert "no destinations" in source
