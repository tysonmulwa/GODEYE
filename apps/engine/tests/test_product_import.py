"""Importing a workspace's catalogue.

Two behaviours carry the weight: consent is enforced where the request would
actually go out, and a re-import updates rather than duplicating.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pytest

from godeye_engine.products.extract import Product as Extracted
from godeye_engine.products.sources import FOUND, NEEDS_RENDERING, ImportResult
from godeye_engine.tasks import products as task
from godeye_engine.tasks.products import NO_CONSENT, content_hash, import_products

NOW = datetime(2026, 8, 2, 16, 0, 0)


def _product(title="Chelsea Boot", price="7499.00", url="https://shop/x", **kw):
    return Extracted(
        title=title,
        url=url,
        price=Decimal(price) if price else None,
        description=kw.get("description", "Leather"),
        image_url=kw.get("image_url", "https://cdn/x.jpg"),
        availability=kw.get("availability", "InStock"),
        currency=kw.get("currency", "KES"),
        source="jsonld",
    )


class FakeSession:
    """Records what the task writes, and answers what it reads."""

    def __init__(self, profile, existing):
        self.profile = profile
        self.existing = existing
        self.inserts: list[dict] = []
        self.updates: list[dict] = []
        self.committed = False

    def execute(self, statement):
        text = str(statement)
        session = self

        class Result:
            def mappings(self):
                return self

            def first(self):
                return session.profile

            def all(self):
                return session.existing

            def scalar(self):
                return None

        if text.strip().upper().startswith("INSERT"):
            self.inserts.append(dict(statement.compile().params))
            return None
        if text.strip().upper().startswith("UPDATE"):
            self.updates.append(dict(statement.compile().params))
            return None
        return Result()

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def run(monkeypatch):
    def _run(profile, found, existing=None):
        session = FakeSession(profile, existing or [])
        monkeypatch.setattr(task, "get_session", lambda: session)
        monkeypatch.setattr(task, "utcnow", lambda: NOW)
        monkeypatch.setattr(task.sources, "import_from_site", lambda *a, **kw: found)
        return import_products("org1"), session

    return _run


class TestConsent:
    """Checked where the request would go out, not only in the UI that asked.

    This task can be queued from anywhere, and the consent belongs to the
    workspace rather than to whoever queued it.
    """

    def test_refuses_without_consent(self, run, monkeypatch):
        called = []
        monkeypatch.setattr(
            task.sources, "import_from_site", lambda *a, **kw: called.append(1)
        )
        result, _ = run(
            {"website": "https://shop.example", "productImportConsentAt": None},
            ImportResult(verdict=FOUND),
        )
        assert result["verdict"] == NO_CONSENT
        assert result["imported"] == 0

    def test_does_not_touch_the_site_without_consent(self, monkeypatch):
        """The refusal has to happen before the request, not after it."""
        session = FakeSession({"website": "https://s.example", "productImportConsentAt": None}, [])
        monkeypatch.setattr(task, "get_session", lambda: session)
        visited = []
        monkeypatch.setattr(
            task.sources, "import_from_site", lambda *a, **kw: visited.append(a)
        )
        import_products("org1")
        assert visited == [], "fetched the site despite having no consent"

    def test_a_workspace_with_no_profile_is_treated_as_no_consent(self, run):
        result, _ = run(None, ImportResult(verdict=FOUND))
        assert result["verdict"] == NO_CONSENT

    def test_proceeds_once_consent_is_recorded(self, run):
        result, _ = run(
            {"website": "https://shop.example", "productImportConsentAt": NOW},
            ImportResult(verdict=FOUND, products=[_product()], route="jsonld", pages_read=2),
        )
        assert result["verdict"] == FOUND
        assert result["imported"] == 1


class TestStoring:
    CONSENTED = {"website": "https://shop.example", "productImportConsentAt": NOW}

    def test_a_new_product_is_inserted(self, run):
        result, session = run(self.CONSENTED, ImportResult(verdict=FOUND, products=[_product()]))
        assert result["added"] == 1
        assert len(session.inserts) == 1
        assert session.inserts[0]["title"] == "Chelsea Boot"
        assert session.inserts[0]["price"] == Decimal("7499.00")

    def test_a_repeat_import_updates_rather_than_duplicating(self, run):
        """A shop republishing the same page must not read as new arrivals,
        what gets posted is chosen from this."""
        product = _product()
        existing = [
            {"id": "p1", "sourceUrl": product.url, "contentHash": content_hash(product)}
        ]
        result, session = run(
            self.CONSENTED, ImportResult(verdict=FOUND, products=[product]), existing
        )
        assert (result["added"], result["changed"], result["unchanged"]) == (0, 0, 1)
        assert session.inserts == []

    def test_a_changed_price_is_noticed(self, run):
        old = _product(price="7499.00")
        new = _product(price="5999.00")
        existing = [{"id": "p1", "sourceUrl": old.url, "contentHash": content_hash(old)}]
        result, _ = run(self.CONSENTED, ImportResult(verdict=FOUND, products=[new]), existing)
        assert result["changed"] == 1

    def test_going_out_of_stock_is_a_change(self, run):
        listed = _product(availability="InStock")
        sold_out = _product(availability="OutOfStock")
        existing = [{"id": "p1", "sourceUrl": listed.url, "contentHash": content_hash(listed)}]
        result, _ = run(self.CONSENTED, ImportResult(verdict=FOUND, products=[sold_out]), existing)
        assert result["changed"] == 1


class TestHash:
    def test_ignores_fields_that_move_on_every_import(self):
        """lastSeenAt changes every run; hashing it would mark everything
        changed every time and make the whole comparison pointless."""
        assert content_hash(_product()) == content_hash(_product())

    def test_notices_each_field_that_matters(self):
        base = content_hash(_product())
        for kw in (
            {"title": "Different"},
            {"price": "1.00"},
            {"description": "Other"},
            {"image_url": "https://cdn/other.jpg"},
            {"availability": "OutOfStock"},
        ):
            assert content_hash(_product(**kw)) != base, kw


class TestVerdictsPassThrough:
    def test_a_site_needing_rendering_is_reported_not_stored(self, run):
        result, session = run(
            {"website": "https://spa.example", "productImportConsentAt": NOW},
            ImportResult(verdict=NEEDS_RENDERING, detail="needs rendering", pages_read=1),
        )
        assert result["verdict"] == NEEDS_RENDERING
        assert result["imported"] == 0
        assert session.inserts == []

    def test_no_website_is_an_answer_rather_than_a_crash(self, run):
        result, _ = run(
            {"website": None, "productImportConsentAt": NOW}, ImportResult(verdict=FOUND)
        )
        assert result["imported"] == 0
        assert "website" in result["detail"]
