"""Finding a shop's products by the cheapest route it offers.

The behaviour worth protecting is the verdict, not the count. "Nothing found"
means two different things — a storefront we cannot read without a browser, and
a site that does not sell anything — and only one of them is worth retrying.
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from godeye_engine.products import sources
from godeye_engine.products.sources import (
    FOUND,
    NEEDS_RENDERING,
    NO_CATALOGUE,
    UNREACHABLE,
    discover_product_urls,
    import_from_site,
    shopify_feed,
)

SHOPIFY_PAYLOAD = {
    "products": [
        {
            "title": "Chelsea Boot",
            "handle": "chelsea-boot",
            "body_html": "<p>Full-grain <b>leather</b></p>",
            "variants": [{"price": "7499.00", "sku": "MC-441", "available": True}],
            "images": [{"src": "https://cdn.shop/boot.jpg"}],
        },
        {
            "title": "Canvas Tote",
            "handle": "canvas-tote",
            "variants": [{"price": "1200.00", "available": False}],
            "images": [],
        },
    ]
}

SHELL = '<html><body><div id="root"></div><script src="/a.js"></script></body></html>'
PRODUCT_PAGE = """<html><body><script type="application/ld+json">
{"@type":"Product","name":"Hand Cream","offers":{"price":"9.99","priceCurrency":"GBP"}}
</script></body></html>"""


def fake_transport(routes: dict):
    """Serve canned responses; anything unrouted 404s.

    Every request goes through here, so a test cannot accidentally reach the
    internet and pass for the wrong reason.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        key = str(request.url)
        for pattern, response in routes.items():
            if pattern in key:
                return response
        return httpx.Response(404, text="not found")

    return httpx.MockTransport(handler)


@pytest.fixture
def routed(monkeypatch):
    def _install(routes: dict):
        transport = fake_transport(routes)
        monkeypatch.setattr(
            sources,
            "_client",
            lambda: httpx.Client(transport=transport, follow_redirects=True),
        )

    return _install


class TestShopifyFeed:
    def test_reads_the_whole_catalogue_from_one_request(self, routed):
        routed({
            "products.json": httpx.Response(200, json=SHOPIFY_PAYLOAD),
            "https://shop.example": httpx.Response(200, text="<html></html>"),
        })
        result = import_from_site("https://shop.example")
        assert result.verdict == FOUND
        assert result.route == "shopify"
        assert result.pages_read == 1, "one request, not a crawl"
        assert [p.title for p in result.products] == ["Chelsea Boot", "Canvas Tote"]

    def test_carries_price_sku_image_and_stock(self, routed):
        routed({
            "products.json": httpx.Response(200, json=SHOPIFY_PAYLOAD),
            "https://shop.example": httpx.Response(200, text="<html></html>"),
        })
        boot, tote = import_from_site("https://shop.example").products
        assert boot.price == Decimal("7499.00")
        assert boot.sku == "MC-441"
        assert boot.image_url == "https://cdn.shop/boot.jpg"
        assert boot.availability == "InStock"
        assert boot.description == "Full-grain leather"
        assert tote.availability == "OutOfStock"

    def test_a_single_page_app_answering_200_is_not_mistaken_for_shopify(self, routed):
        """SPA storefronts serve their HTML shell for every path, so a 200 on
        /products.json means nothing. The body has to decide."""
        routed({
            "products.json": httpx.Response(200, text=SHELL),
            "https://spa.example": httpx.Response(200, text=SHELL),
        })
        result = import_from_site("https://spa.example")
        assert result.route != "shopify"
        assert result.verdict == NEEDS_RENDERING

    def test_html_at_the_feed_url_returns_none_rather_than_raising(self):
        client = httpx.Client(transport=fake_transport({"products.json": httpx.Response(200, text="<html>")}))
        assert shopify_feed("https://x.example", client) is None

    def test_json_that_is_not_a_catalogue_is_refused(self):
        client = httpx.Client(
            transport=fake_transport({"products.json": httpx.Response(200, json={"error": "nope"})})
        )
        assert shopify_feed("https://x.example", client) is None


class TestCrawling:
    def test_reads_product_pages_found_in_the_sitemap(self, routed):
        sitemap = (
            "<urlset><loc>https://shop.example/products/hand-cream</loc>"
            "<loc>https://shop.example/about</loc></urlset>"
        )
        routed({
            "products.json": httpx.Response(404),
            "sitemap.xml": httpx.Response(
                200, text=sitemap, headers={"content-type": "application/xml"}
            ),
            "/products/hand-cream": httpx.Response(200, text=PRODUCT_PAGE),
            "https://shop.example": httpx.Response(200, text="<html><body>Shop</body></html>"),
        })
        result = import_from_site("https://shop.example")
        assert result.verdict == FOUND
        assert result.route == "crawl"
        assert [p.title for p in result.products] == ["Hand Cream"]

    def test_a_sitemap_served_as_html_is_ignored(self, routed):
        """Every path 200s on a SPA, including this one. Trusting the status
        would have the crawler follow its own homepage as a product list."""
        client = httpx.Client(
            transport=fake_transport({
                "sitemap": httpx.Response(200, text=SHELL, headers={"content-type": "text/html"}),
                "https://spa.example": httpx.Response(200, text=SHELL),
            })
        )
        assert discover_product_urls("https://spa.example", client, 10) == []

    def test_only_product_shaped_paths_are_followed(self, routed):
        home = (
            '<a href="/products/one">1</a><a href="/blog/post">no</a>'
            '<a href="/cart">no</a><a href="/item/two">2</a>'
        )
        client = httpx.Client(
            transport=fake_transport({"https://shop.example": httpx.Response(200, text=home)})
        )
        urls = discover_product_urls("https://shop.example", client, 10)
        assert urls == ["https://shop.example/products/one", "https://shop.example/item/two"]

    def test_offsite_links_are_not_followed(self):
        home = '<a href="https://elsewhere.example/products/x">x</a><a href="/products/mine">m</a>'
        client = httpx.Client(
            transport=fake_transport({"https://shop.example": httpx.Response(200, text=home)})
        )
        assert discover_product_urls("https://shop.example", client, 10) == [
            "https://shop.example/products/mine"
        ]


class TestVerdicts:
    """Zero products is not one outcome. The message differs, so the verdict
    has to as well."""

    def test_a_client_rendered_storefront_asks_for_a_browser(self, routed):
        routed({"https://spa.example": httpx.Response(200, text=SHELL)})
        result = import_from_site("https://spa.example")
        assert result.verdict == NEEDS_RENDERING
        # Names what to set up rather than only reporting failure.
        assert "browser" in (result.detail or "").lower()
        assert "BROWSER_RENDER_URL" in (result.detail or "")

    def test_a_site_that_sells_nothing_says_so_plainly(self, routed):
        """The real case: a dating app has no catalogue. That is an answer, not
        a failure, and retrying it forever would be the wrong response."""
        page = "<html><body>" + ("<p>About our community. </p>" * 100) + "</body></html>"
        routed({"https://app.example": httpx.Response(200, text=page)})
        result = import_from_site("https://app.example")
        assert result.verdict == NO_CATALOGUE
        assert not result.ok

    def test_an_unreachable_site_is_reported_not_raised(self, monkeypatch):
        def boom(request):
            raise httpx.ConnectError("dns failure")

        transport = httpx.MockTransport(boom)
        # monkeypatch, not assignment: setting the module attribute directly
        # leaks into every test that runs afterwards.
        monkeypatch.setattr(sources, "_client", lambda: httpx.Client(transport=transport))
        result = import_from_site("https://gone.example")
        assert result.verdict == UNREACHABLE
        assert "gone.example" in (result.detail or "")

    def test_an_error_status_is_reported_not_raised(self, routed):
        routed({"https://shop.example": httpx.Response(503, text="down")})
        result = import_from_site("https://shop.example")
        assert result.verdict == UNREACHABLE
        assert "503" in (result.detail or "")

    def test_being_refused_is_told_apart_from_being_unreachable(self, routed):
        """Every major storefront tested answered 429 from behind its CDN, and
        did so for a browser user agent too. The site is fine and the owner can
        let us through, so this must not read as "your site is down"."""
        for status in (403, 429):
            routed({"https://shop.example": httpx.Response(status, text="blocked")})
            result = import_from_site("https://shop.example")
            assert result.verdict == sources.BLOCKED, status
            assert sources.USER_AGENT in (result.detail or ""), "must say what to allow"


def test_the_crawler_identifies_itself():
    """A shop owner reading their logs should be able to tell who this is."""
    assert "GODEYE" in sources.USER_AGENT and "http" in sources.USER_AGENT
