"""Crawler URL handling and HTML parsing (no network)."""

from godeye_engine.seo import crawler

HTML = """
<!doctype html>
<html>
<head>
  <title>Acme Coffee. Fresh Roasts</title>
  <meta name="description" content="Specialty coffee roasted in Nairobi.">
  <link rel="canonical" href="https://example.com/">
  <meta property="og:title" content="Acme Coffee">
  <script type="application/ld+json">{"@type": "Organization"}</script>
</head>
<body>
  <h1>Fresh Coffee</h1>
  <h2>Our beans</h2><h2>Our story</h2>
  <img src="/a.jpg" alt="beans"><img src="/b.jpg" alt=""><img src="/c.jpg">
  <a href="/shop">Shop</a>
  <a href="https://example.com/about#team">About</a>
  <a href="https://other.com/page">External</a>
  <a href="mailto:hi@example.com">Mail</a>
  <a href="#section">Anchor</a>
  <p>Some body copy about coffee roasting and delivery.</p>
</body>
</html>
"""


class TestNormalizeUrl:
    def test_resolves_relative(self):
        assert (
            crawler.normalize_url("/shop", base="https://example.com/page")
            == "https://example.com/shop"
        )

    def test_drops_fragment(self):
        assert crawler.normalize_url("https://example.com/about#team") == "https://example.com/about"

    def test_strips_trailing_slash_but_keeps_root(self):
        assert crawler.normalize_url("https://example.com/about/") == "https://example.com/about"
        assert crawler.normalize_url("https://example.com/") == "https://example.com/"

    def test_keeps_query(self):
        assert (
            crawler.normalize_url("https://example.com/p?page=2")
            == "https://example.com/p?page=2"
        )


class TestSameDomain:
    def test_exact_and_www(self):
        assert crawler.same_domain("https://example.com/x", "https://example.com/")
        assert crawler.same_domain("https://www.example.com/x", "https://example.com/")
        assert not crawler.same_domain("https://other.com/x", "https://example.com/")


class TestParsePage:
    def setup_method(self):
        self.page = crawler.parse_page("https://example.com/", HTML, 200, 250)

    def test_meta_extraction(self):
        assert self.page.title == "Acme Coffee. Fresh Roasts"
        assert self.page.meta_description == "Specialty coffee roasted in Nairobi."
        assert self.page.canonical == "https://example.com/"

    def test_headings(self):
        assert self.page.h1s == ["Fresh Coffee"]
        assert self.page.h2_count == 2

    def test_images_alt_counting(self):
        assert self.page.images_total == 3
        assert self.page.images_missing_alt == 2  # empty alt + missing alt

    def test_link_classification(self):
        # /shop and /about (fragment dropped) are internal; mailto/anchor skipped
        assert "https://example.com/shop" in self.page.internal_links
        assert "https://example.com/about" in self.page.internal_links
        assert self.page.external_links_count == 1

    def test_structured_data_flags(self):
        assert self.page.has_og_tags is True
        assert self.page.has_json_ld is True

    def test_https_flag(self):
        assert self.page.is_https is True
