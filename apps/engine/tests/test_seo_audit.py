"""SEO audit rules, score computation, and generators."""

from godeye_engine.seo import audit, generators
from godeye_engine.seo.crawler import CrawlResult, PageData


def make_page(**overrides) -> PageData:
    """A page that passes every rule; override fields to trigger findings."""
    defaults = dict(
        url="https://example.com/",
        status_code=200,
        response_time_ms=300,
        title="Great Coffee Roastery in Nairobi | Acme",
        meta_description="Acme roasts specialty single-origin Kenyan coffee. "
        "Order fresh beans online with free Nairobi delivery.",
        canonical="https://example.com/",
        meta_robots=None,
        h1s=["Great Coffee, Roasted Fresh"],
        h2_count=3,
        word_count=800,
        images_total=4,
        images_missing_alt=0,
        internal_links=[],
        external_links_count=2,
        has_og_tags=True,
        has_json_ld=True,
        is_https=True,
    )
    defaults.update(overrides)
    return PageData(**defaults)


def make_result(pages, broken=None, robots=True, sitemap=True) -> CrawlResult:
    return CrawlResult(
        start_url="https://example.com/",
        pages=pages,
        broken_links=broken or {},
        has_robots_txt=robots,
        has_sitemap_xml=sitemap,
    )


class TestPageRules:
    def test_clean_page_has_no_findings(self):
        assert audit.audit_page(make_page()) == []

    def test_missing_title_is_critical(self):
        findings = audit.audit_page(make_page(title=None))
        assert any(f.code == "missing_title" and f.severity == "critical" for f in findings)

    def test_long_title_warns(self):
        findings = audit.audit_page(make_page(title="x" * 90))
        assert any(f.code == "title_too_long" for f in findings)

    def test_missing_description(self):
        findings = audit.audit_page(make_page(meta_description=None))
        assert any(f.code == "missing_description" for f in findings)

    def test_h1_rules(self):
        assert any(f.code == "missing_h1" for f in audit.audit_page(make_page(h1s=[])))
        assert any(f.code == "multiple_h1" for f in audit.audit_page(make_page(h1s=["a", "b"])))

    def test_thin_content(self):
        findings = audit.audit_page(make_page(word_count=50))
        assert any(f.code == "thin_content" for f in findings)

    def test_images_missing_alt(self):
        findings = audit.audit_page(make_page(images_missing_alt=2))
        assert any(f.code == "images_missing_alt" for f in findings)

    def test_http_is_critical(self):
        findings = audit.audit_page(make_page(url="http://example.com/", is_https=False))
        assert any(f.code == "not_https" and f.severity == "critical" for f in findings)

    def test_noindex_is_critical(self):
        findings = audit.audit_page(make_page(meta_robots="noindex, nofollow"))
        assert any(f.code == "noindex" and f.severity == "critical" for f in findings)

    def test_slow_response_warns(self):
        findings = audit.audit_page(make_page(response_time_ms=3000))
        assert any(f.code == "slow_response" for f in findings)


class TestSiteRules:
    def test_duplicate_titles_detected(self):
        pages = [
            make_page(url="https://example.com/a"),
            make_page(url="https://example.com/b"),
        ]
        findings = audit.audit_site(make_result(pages))
        assert any(f.code == "duplicate_title" for f in findings)

    def test_broken_links_reported(self):
        result = make_result(
            [make_page()], broken={"https://example.com/dead": ["https://example.com/"]}
        )
        findings = audit.audit_site(result)
        assert any(f.code == "broken_link" and f.severity == "critical" for f in findings)

    def test_missing_robots_and_sitemap(self):
        findings = audit.audit_site(make_result([make_page()], robots=False, sitemap=False))
        codes = {f.code for f in findings}
        assert "missing_robots" in codes and "missing_sitemap" in codes


class TestScore:
    def test_perfect_site_scores_100(self):
        assert audit.compute_score([], pages_crawled=5) == 100

    def test_zero_pages_scores_zero(self):
        assert audit.compute_score([], pages_crawled=0) == 0

    def test_critical_findings_hurt_more_than_info(self):
        critical = [audit.Finding("critical", "c1", "p", "m", "r")]
        info = [audit.Finding("info", "i1", "p", "m", "r")]
        assert audit.compute_score(critical, 1) < audit.compute_score(info, 1)

    def test_penalty_per_code_is_capped(self):
        # 50 identical criticals shouldn't nuke the score below the cap for one code
        findings = [audit.Finding("critical", "same", f"p{i}", "m", "r") for i in range(50)]
        assert audit.compute_score(findings, 50) == 100 - audit.MAX_PENALTY_PER_CODE

    def test_score_never_negative(self):
        findings = [
            audit.Finding("critical", f"code{i}", "p", "m", "r") for i in range(30)
        ]
        assert audit.compute_score(findings, 1) == 0


class TestGenerators:
    def test_sitemap_contains_ok_pages_only(self):
        pages = [
            make_page(url="https://example.com/"),
            make_page(url="https://example.com/about"),
            make_page(url="https://example.com/hidden", meta_robots="noindex"),
        ]
        xml = generators.generate_sitemap(make_result(pages))
        assert "<loc>https://example.com/</loc>" in xml
        assert "<loc>https://example.com/about</loc>" in xml
        assert "hidden" not in xml
        assert xml.startswith('<?xml version="1.0"')

    def test_sitemap_deduplicates(self):
        pages = [make_page(), make_page()]
        xml = generators.generate_sitemap(make_result(pages))
        assert xml.count("<loc>https://example.com/</loc>") == 1

    def test_robots_points_to_sitemap(self):
        robots = generators.generate_robots("https://example.com/some/page")
        assert "User-agent: *" in robots
        assert "Sitemap: https://example.com/sitemap.xml" in robots
