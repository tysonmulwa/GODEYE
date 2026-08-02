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
    than the transport handed in — that is what it actually calls.

    The real class is captured first: supabase_store.httpx is the httpx module
    itself, so the replacement would otherwise call itself forever.
    """
    real_client = httpx.Client
    monkeypatch.setattr(
        supabase_store.httpx,
        "Client",
        lambda **kwargs: real_client(transport=mock_transport(routes)),
    )


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

    def test_the_shops_own_sale_columns_are_never_read(self, monkeypatch):
        """The table carries on_sale and original_price for its own pages.
        Announcing a reduction lawfully requires the lowest price of the last
        30 days, and a "was" price is not that — so these are left alone."""
        serving(monkeypatch, {"/products": httpx.Response(200, json=[ROW])})
        [product] = fetch_products(self._backend(), "https://shop.example")
        serialised = str(product.as_dict())
        assert "12000" not in serialised, "leaked a former price into the catalogue"
        assert product.price == Decimal("8500")

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
