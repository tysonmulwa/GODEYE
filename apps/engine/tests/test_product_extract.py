"""Reading a shop's catalogue off its own pages.

The failure that matters here is not an exception, it is a wrong number: a
price read as 1.299 when the shop meant 1299 puts that on a customer's feed.
"""

from __future__ import annotations

from decimal import Decimal

from bs4 import BeautifulSoup

from godeye_engine.products.extract import (
    Product,
    extract_products,
    from_jsonld,
    from_microdata,
    from_opengraph,
    looks_client_rendered,
    parse_price,
)

SHOPIFY_STYLE = """
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product",
 "name":"Leather Chelsea Boot","sku":"MC-441",
 "description":"<p>Full-grain leather,  handmade.</p>",
 "image":["https://cdn.shop/boot.jpg"],
 "url":"/products/chelsea-boot",
 "offers":{"@type":"Offer","price":"7499.00","priceCurrency":"KES",
           "availability":"http://schema.org/InStock"}}
</script>
</head><body></body></html>
"""


class TestPrices:
    """A wrong price is worse than no price: it goes out on a post."""

    def test_plain_decimal(self):
        assert parse_price("7499.00") == Decimal("7499.00")

    def test_a_symbol_and_thousands_separator(self):
        assert parse_price("KSh 1,200.00") == Decimal("1200.00")
        assert parse_price("$45") == Decimal("45")

    def test_european_notation_is_not_read_as_a_fraction(self):
        """1.299,00 is one thousand two hundred and ninety nine."""
        assert parse_price("1.299,00") == Decimal("1299.00")

    def test_a_comma_decimal_without_a_point(self):
        assert parse_price("19,99") == Decimal("19.99")

    def test_a_comma_thousands_group_without_decimals(self):
        assert parse_price("1,200") == Decimal("1200")

    def test_numbers_arrive_as_numbers_too(self):
        assert parse_price(45.5) == Decimal("45.5")

    def test_text_that_is_not_a_price_returns_nothing(self):
        for junk in (None, "", "Call for pricing", ", "):
            assert parse_price(junk) is None

    def test_a_negative_price_is_not_a_price(self):
        assert parse_price("-10") is None


class TestJsonLd:
    def test_reads_a_standard_product_block(self):
        [product] = from_jsonld(SHOPIFY_STYLE, "https://shop.example")
        assert product.title == "Leather Chelsea Boot"
        assert product.price == Decimal("7499.00")
        assert product.currency == "KES"
        assert product.sku == "MC-441"
        assert product.availability == "InStock"
        assert product.image_url == "https://cdn.shop/boot.jpg"

    def test_relative_urls_are_resolved_against_the_shop(self):
        [product] = from_jsonld(SHOPIFY_STYLE, "https://shop.example")
        assert product.url == "https://shop.example/products/chelsea-boot"

    def test_markup_is_stripped_out_of_the_description(self):
        [product] = from_jsonld(SHOPIFY_STYLE, "https://shop.example")
        assert product.description == "Full-grain leather, handmade."

    def test_finds_products_nested_in_a_graph(self):
        html = """<script type="application/ld+json">
        {"@graph":[{"@type":"WebSite","name":"Shop"},
                   {"@type":"Product","name":"Mug","offers":{"price":"9.99"}}]}
        </script>"""
        [product] = from_jsonld(html, "https://shop.example")
        assert product.title == "Mug"

    def test_finds_products_in_a_collection_listing(self):
        """A category page lists many products in one ItemList."""
        html = """<script type="application/ld+json">
        {"@type":"ItemList","itemListElement":[
          {"@type":"ListItem","item":{"@type":"Product","name":"One"}},
          {"@type":"ListItem","item":{"@type":"Product","name":"Two"}}]}
        </script>"""
        assert [p.title for p in from_jsonld(html, "https://s.example")] == ["One", "Two"]

    def test_an_aggregate_offer_reports_the_low_price(self):
        """A range has to become one number, and the low one is the honest
        headline, it is what the shop advertises as 'from'."""
        html = """<script type="application/ld+json">
        {"@type":"Product","name":"Tee","offers":{"@type":"AggregateOffer",
         "lowPrice":"12.00","highPrice":"20.00","priceCurrency":"GBP"}}
        </script>"""
        [product] = from_jsonld(html, "https://s.example")
        assert product.price == Decimal("12.00")
        assert product.currency == "GBP"

    def test_one_broken_block_does_not_cost_the_others(self):
        html = """
        <script type="application/ld+json">{not json at all</script>
        <script type="application/ld+json">{"@type":"Product","name":"Survivor"}</script>
        """
        assert [p.title for p in from_jsonld(html, "https://s.example")] == ["Survivor"]

    def test_a_page_with_no_products_yields_none(self):
        html = """<script type="application/ld+json">
        {"@type":"Organization","name":"Just a company"}</script>"""
        assert from_jsonld(html, "https://s.example") == []


class TestMicrodataAndOpenGraph:
    def test_microdata_prefers_the_machine_readable_value(self):
        """The visible text is localised and formatted; content= is neither."""
        html = """
        <div itemscope itemtype="http://schema.org/Product">
          <h1 itemprop="name">Canvas Tote</h1>
          <meta itemprop="price" content="1500.00">
          <meta itemprop="priceCurrency" content="KES">
        </div>"""
        [product] = from_microdata(html, "https://s.example")
        assert product.title == "Canvas Tote"
        assert product.price == Decimal("1500.00")
        assert product.currency == "KES"

    def test_opengraph_only_counts_when_the_page_says_it_is_a_product(self):
        article = '<meta property="og:type" content="article">' \
                  '<meta property="og:title" content="A blog post">'
        assert from_opengraph(article, "https://s.example") == []

    def test_opengraph_reads_price_and_currency(self):
        html = """
        <meta property="og:type" content="product">
        <meta property="og:title" content="Running Shoe">
        <meta property="product:price:amount" content="89.99">
        <meta property="product:price:currency" content="EUR">"""
        [product] = from_opengraph(html, "https://s.example")
        assert product.price == Decimal("89.99")
        assert product.currency == "EUR"


class TestCombining:
    def test_the_same_product_from_two_sources_is_reported_once(self):
        """A Shopify page emits JSON-LD and OpenGraph for the same item; a
        catalogue with everything listed twice is not a catalogue."""
        html = SHOPIFY_STYLE.replace(
            "</head>",
            '<meta property="og:type" content="product">'
            '<meta property="og:title" content="Leather Chelsea Boot"></head>',
        )
        products = extract_products(html, "https://shop.example")
        assert len(products) == 1
        # The richer source wins, so the price survives.
        assert products[0].price == Decimal("7499.00")

    def test_opengraph_still_fills_in_when_there_is_no_json_ld(self):
        html = """
        <meta property="og:type" content="product">
        <meta property="og:title" content="Only Here">"""
        assert [p.title for p in extract_products(html, "https://s.example")] == ["Only Here"]


class TestClientRendered:
    """Telling a site we cannot read apart from a shop with nothing to sell.

    Both return zero products, and the difference is the whole message: one is
    'turn on rendering', the other is 'there is nothing here'.
    """

    def test_a_storefront_shell_is_recognised(self):
        # What mjinicollection.com actually serves: a few KB and a mount point.
        html = '<html><body><div id="root"></div><script src="/assets/index.js"></script></body></html>'
        assert looks_client_rendered(html) is True

    def test_a_real_rendered_page_is_not(self):
        html = "<html><body>" + ("<p>Real copy about the product. </p>" * 80) + "</body></html>"
        assert looks_client_rendered(html) is False

    def test_a_large_page_is_never_treated_as_a_shell(self):
        assert looks_client_rendered("<html><body>" + "x" * 130_000 + "</body></html>") is False

    def test_a_server_rendered_shop_is_not_sent_off_to_be_rendered_again(self):
        """A real WooCommerce product page came to 117 KB with 1127 characters
        of body text, the weight is markup, not prose. Short text plus a
        script tag matched it, and would have cost a headless render per page
        for a shop that was already perfectly readable."""
        html = (
            "<html><body>"
            + "<div class='product'><span>x</span></div>" * 40
            + "<script src='/wp-includes/jquery.js'></script>"
            + "</body></html>"
        )
        assert len(BeautifulSoup(html, "html.parser").find("body").get_text(strip=True)) < 1500
        assert looks_client_rendered(html) is False


def test_product_serialises_for_storage():
    product = Product(title="T", url="https://s/x", price=Decimal("10.50"), currency="USD")
    data = product.as_dict()
    # Decimal is not JSON, and a float price is how rounding errors reach a post.
    assert data["price"] == "10.50"
    assert isinstance(data["price"], str)
