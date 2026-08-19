"""Reading a storefront through the API its own pages call.

Verified against a real shop: mjinicollection.com is a single-page app whose
catalogue lives in Supabase, and whose bundle carries the project URL and the
publishable key because every visitor's browser needs them.
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from godeye_engine.products import supabase_store
from godeye_engine.products.compliance import currency_for_location
from godeye_engine.products.supabase_store import Backend, discover, fetch_products

KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMH0.aBcDeFgHiJkLmNoP"
BUNDLE = f"""
const supabaseUrl = "https://fbvruzkaohzdfzpfeuna.supabase.co";
const key = "{KEY}";
export const cart = () => sb.from("cart_items").select();
export const all = () => sb.from("products").select("*");
export const settings = () => sb.from("store_settings").select();
"""
SHELL = (
    '<html><body><div id="root"></div>'
    '<script src="/assets/index-abc.js"></script></body></html>'
)

# Shaped like the real table: a price with no currency column beside it, and
# an on_sale/original_price pair the shop keeps for its own pages.
ROW = {
    "id": "p1",
    "name": "Premium Perfume",
    "description": "A warm amber scent.",
    "price": 8500,
    "original_price": 12000,
    "on_sale": True,
    "in_stock": True,
    "image": "https://cdn/perfume.jpg",
    "images": ["https://cdn/perfume.jpg"],
}


def mock_transport(routes):
    def handler(request):
        for pattern, response in routes.items():
            if pattern in str(request.url):
                return response
        return httpx.Response(404, text="no")

    return httpx.MockTransport(handler)


def serving(monkeypatch, routes):
    """Make supabase_store's own client speak to canned responses.

    It builds its client with auth headers, so the factory is replaced rather
    than the transport handed in, that is what it actually calls.

    It now builds a SafeClient rather than an httpx.Client, because the backend
    URL is scraped out of the customer's own page HTML and is therefore
    attacker-controlled (the egress guard, findings S-2/S-3). These tests are
    about mapping a row onto a Product, so the guard is stubbed here rather than
    exercised; its own behaviour is covered in test_egress.py, which is where a
    weakened guard would show up.
    """
    real_client = httpx.Client

    class StubbedSafeClient:
        def __init__(self, **_kwargs):
            self._client = real_client(transport=mock_transport(routes))

        def get(self, url, *, params=None, timeout=None):
            return self._client.get(url, params=params)

        def close(self):
            self._client.close()

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            self.close()

    monkeypatch.setattr(supabase_store, "SafeClient", StubbedSafeClient)


class TestDiscovery:
    def test_finds_the_backend_in_the_bundle_not_the_page(self):
        """The page is a mount point; the configuration is in the JavaScript
        beside it."""
        client = httpx.Client(transport=mock_transport({"index-abc.js": httpx.Response(200, text=BUNDLE)}))
        backend = discover(SHELL, "https://shop.example", client)
        assert backend is not None
        assert backend.url == "https://fbvruzkaohzdfzpfeuna.supabase.co"
        assert backend.key == KEY

    def test_prefers_a_table_that_sounds_like_a_catalogue(self):
        client = httpx.Client(transport=mock_transport({"index-abc.js": httpx.Response(200, text=BUNDLE)}))
        assert discover(SHELL, "https://shop.example", client).tables[0] == "products"

    def test_never_treats_carts_or_users_as_a_catalogue(self):
        client = httpx.Client(transport=mock_transport({"index-abc.js": httpx.Response(200, text=BUNDLE)}))
        tables = discover(SHELL, "https://shop.example", client).tables
        assert "cart_items" not in tables and "store_settings" not in tables

    def test_a_site_with_no_such_backend_returns_nothing(self):
        client = httpx.Client(transport=mock_transport({}))
        assert discover("<html><body>Plain site</body></html>", "https://x.example", client) is None

    def test_a_bot_check_script_is_not_mistaken_for_the_shop(self):
        """Cloudflare injects its own bundle; it is not the storefront's."""
        page = '<html><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>'
        asked: list[str] = []

        def handler(request):
            asked.append(str(request.url))
            return httpx.Response(200, text="var x=1")

        discover(page, "https://x.example", httpx.Client(transport=httpx.MockTransport(handler)))
        assert not any("challenge-platform" in u for u in asked)


class TestReading:
    def _backend(self):
        return Backend("https://proj.supabase.co", KEY, ["products"])

    def test_maps_a_row_onto_a_product(self, monkeypatch):
        serving(monkeypatch, {"/products": httpx.Response(200, json=[ROW])})
        [product] = fetch_products(self._backend(), "https://shop.example")
        assert product.title == "Premium Perfume"
        assert product.price == Decimal("8500")
        assert product.availability == "InStock"
        assert product.image_url == "https://cdn/perfume.jpg"
        assert product.source == "storefront_api"

    def test_the_former_price_is_captured_as_evidence(self, monkeypatch):
        """The table carries original_price for the shop's own pages. It is
        read but never automatically published: whether a post may say it
        depends on where the shop sells, which is decided per post rather than
        by whether the number happens to be here."""
        serving(monkeypatch, {"/products": httpx.Response(200, json=[ROW])})
        [product] = fetch_products(self._backend(), "https://shop.example")
        assert product.price == Decimal("8500")
        assert product.compare_at_price == Decimal("12000")

    def test_capturing_it_does_not_by_itself_permit_saying_it(self, monkeypatch):
        """The evidence existing and the claim being lawful are two different
        questions, and holding the number must not answer the second."""
        from godeye_engine.products.compliance import price_comparison_allowed

        serving(monkeypatch, {"/products": httpx.Response(200, json=[ROW])})
        [product] = fetch_products(self._backend(), "https://shop.example")
        assert not price_comparison_allowed(
            "Munich, Germany", product.compare_at_price, product.price
        )

    def test_stock_is_only_reported_when_the_row_says(self, monkeypatch):
        """Guessing "in stock" would put a claim in a post nothing supports."""
        row = {k: v for k, v in ROW.items() if k != "in_stock"}
        serving(monkeypatch, {"/products": httpx.Response(200, json=[row])})
        [product] = fetch_products(self._backend(), "https://shop.example")
        assert product.availability is None

    def test_a_row_with_no_name_is_skipped(self, monkeypatch):
        serving(monkeypatch, {"/products": httpx.Response(200, json=[{"id": "x", "price": 5}])})
        assert fetch_products(self._backend(), "https://shop.example") == []

    def test_a_table_that_is_not_public_is_passed_over_quietly(self, monkeypatch):
        """Row-level security refusing us is the shop's choice, not an error."""
        serving(monkeypatch, {"/products": httpx.Response(401)})
        assert fetch_products(self._backend(), "https://shop.example") == []


class TestCurrencyFallback:
    """A shop whose own site only sells in one currency often stores none."""

    @pytest.mark.parametrize(
        "location,code",
        [
            ("Nairobi, Kenya", "KES"),
            ("Berlin, Germany", "EUR"),
            ("Paris, France", "EUR"),
            ("London, United Kingdom", "GBP"),
            ("Dublin, Ireland", "EUR"),
            ("Zurich, Switzerland", "CHF"),
            ("Stockholm, Sweden", "SEK"),
            ("Warsaw, Poland", "PLN"),
        ],
    )
    def test_derives_it_from_where_the_shop_says_it_is(self, location, code):
        assert currency_for_location(location) == code

    def test_an_unknown_place_stays_unknown(self):
        """Better a bare number than a confidently wrong currency symbol."""
        assert currency_for_location("Somewhere") is None
        assert currency_for_location(None) is None
