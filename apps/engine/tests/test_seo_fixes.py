"""Fix generation, stack detection, and IndexNow, the apply/announce half of SEO."""

import pytest

from godeye_engine.seo import crawler, fixes, indexnow
from godeye_engine.seo.audit import Finding
from godeye_engine.seo.crawler import CrawlResult, PageData


def make_page(**overrides) -> PageData:
    defaults = dict(
        url="https://example.com/",
        status_code=200,
        response_time_ms=300,
        title="Acme",
        meta_description=None,
        h1s=["Fresh Coffee"],
        word_count=800,
        is_https=True,
    )
    defaults.update(overrides)
    return PageData(**defaults)


def make_result(pages=None, platform="html") -> CrawlResult:
    return CrawlResult(
        start_url="https://example.com/",
        pages=pages or [make_page()],
        broken_links={},
        has_robots_txt=True,
        has_sitemap_xml=True,
        platform=platform,
    )


def finding(code, page="https://example.com/", severity="warning") -> Finding:
    return Finding(severity, code, page, f"{code} message", "do the thing")


# --------------------------------------------------------------------------
# Platform detection
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "html,expected",
    [
        ('<link href="/wp-content/themes/x/style.css">', "wordpress"),
        ('<script src="/wp-content/plugins/woocommerce/assets/js/a.js">', "woocommerce"),
        ('<script src="https://cdn.shopify.com/s/files/1/t.js">', "shopify"),
        ('<img src="https://static.wixstatic.com/media/a.jpg">', "wix"),
        ('<meta name="generator" content="Webflow">', "webflow"),
        ('<script src="/_next/static/chunks/main.js">', "nextjs"),
        ('<meta name="generator" content="TYPO3 CMS">', "typo3"),
        ('<div id="app"></div>', "html"),
    ],
)
def test_detect_platform(html, expected):
    assert crawler.detect_platform(html) == expected


def test_woocommerce_wins_over_wordpress():
    """WooCommerce sites are WordPress sites, the more specific answer is the
    useful one, because the SEO fields live in a different place."""
    html = '<link href="/wp-content/plugins/woocommerce/x.css"><script src="/wp-includes/a.js">'
    assert crawler.detect_platform(html) == "woocommerce"


def test_detect_platform_falls_back_to_headers():
    assert crawler.detect_platform("<html></html>", {"x-shopid": "shopify-123"}) == "shopify"


# --------------------------------------------------------------------------
# Fix generation
# --------------------------------------------------------------------------


def test_description_fix_carries_the_literal_tag():
    built = fixes.build_fixes(
        result=make_result(),
        findings=[finding("missing_description")],
        meta_suggestions=[
            {"page": "https://example.com/", "suggestedDescription": "Freshly roasted coffee."}
        ],
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert len(built) == 1
    assert built[0].kind == fixes.HEAD_TAG
    assert built[0].after == '<meta name="description" content="Freshly roasted coffee.">'


def test_description_without_a_suggestion_is_manual_not_invented():
    """No AI suggestion means we have nothing to paste. Saying so beats shipping
    a made-up description that misdescribes the customer's page."""
    built = fixes.build_fixes(
        result=make_result(),
        findings=[finding("missing_description")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert built[0].kind == fixes.MANUAL
    assert built[0].after is None


def test_suggested_text_is_escaped_into_the_attribute():
    """A quote in the copy would otherwise close the attribute and produce
    broken markup the user pastes straight into their site."""
    built = fixes.build_fixes(
        result=make_result(),
        findings=[finding("missing_description")],
        meta_suggestions=[
            {"page": "https://example.com/", "suggestedDescription": 'The "best" coffee & more'}
        ],
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    after = built[0].after
    assert "&quot;" in after and "&amp;" in after
    # Exactly two unescaped double quotes: the ones delimiting content="…".
    assert after.count('"') == 4  # name="description" plus content="…"


def test_title_falls_back_to_the_pages_own_h1():
    built = fixes.build_fixes(
        result=make_result([make_page(title=None, h1s=["Fresh Coffee"])]),
        findings=[finding("missing_title", severity="critical")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert built[0].kind == fixes.HEAD_TAG
    assert "Fresh Coffee" in built[0].after


def test_canonical_fix_is_deterministic():
    built = fixes.build_fixes(
        result=make_result(),
        findings=[finding("missing_canonical", page="https://example.com/shop")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert built[0].after == '<link rel="canonical" href="https://example.com/shop">'


def test_guidance_names_the_screen_for_the_detected_stack():
    def guidance_for(platform):
        built = fixes.build_fixes(
            result=make_result(platform=platform),
            findings=[finding("missing_canonical")],
            meta_suggestions=None,
            schema_json=None,
            sitemap_xml=None,
            robots_txt=None,
        )
        return built[0].guidance

    assert "Yoast" in guidance_for("wordpress")
    assert "Search engine listing" in guidance_for("shopify")
    assert "Page Settings" in guidance_for("squarespace")
    assert "next/head" in guidance_for("nextjs")


def test_builder_platforms_are_told_not_to_upload_root_files():
    """Wix and Squarespace serve their own robots.txt and sitemap.xml. Telling a
    Wix user to upload one sends them looking for an FTP account they'll never
    find."""
    built = fixes.build_fixes(
        result=make_result(platform="wix"),
        findings=[finding("missing_robots")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt="User-agent: *\n",
    )
    assert "cannot upload your own" in built[0].guidance


def test_structured_data_is_proposed_only_on_the_home_page():
    built = fixes.build_fixes(
        result=make_result(),
        findings=[
            finding("missing_structured_data", page="https://example.com/"),
            finding("missing_structured_data", page="https://example.com/shop"),
            finding("missing_structured_data", page="https://example.com/about"),
        ],
        meta_suggestions=None,
        schema_json='{"@type": "Organization"}',
        sitemap_xml=None,
        robots_txt=None,
    )
    assert len(built) == 1
    assert built[0].target_url == "https://example.com/"


def test_file_fixes_target_the_site_root():
    built = fixes.build_fixes(
        result=make_result(),
        findings=[finding("missing_robots")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt="User-agent: *\nAllow: /\n",
    )
    fix = built[0]
    assert fix.kind == fixes.FILE
    assert fix.file_path == "robots.txt"
    assert fix.target_url == "https://example.com/robots.txt"
    assert fix.after.startswith("User-agent:")


def test_alt_fix_lists_the_actual_images():
    page = make_page(
        images_total=3,
        images_missing_alt=2,
        images_without_alt=["https://example.com/a.jpg", "https://example.com/b.jpg"],
    )
    built = fixes.build_fixes(
        result=make_result([page]),
        findings=[finding("images_missing_alt")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert "a.jpg" in built[0].guidance and "b.jpg" in built[0].guidance


def test_unpatchable_findings_still_produce_a_fix():
    """A broken link has no snippet to paste, but dropping it silently would
    leave the user thinking the audit found nothing to do."""
    built = fixes.build_fixes(
        result=make_result(),
        findings=[finding("broken_link", severity="critical"), finding("not_https")],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert len(built) == 2
    assert all(f.kind == fixes.MANUAL and f.after is None for f in built)


def test_one_systemic_problem_cannot_flood_the_list():
    built = fixes.build_fixes(
        result=make_result(),
        findings=[
            finding("missing_canonical", page=f"https://example.com/p{i}") for i in range(60)
        ],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
    )
    assert len(built) == fixes.MAX_PER_CODE


def test_indexnow_key_fix_is_included_when_a_key_is_given():
    built = fixes.build_fixes(
        result=make_result(),
        findings=[],
        meta_suggestions=None,
        schema_json=None,
        sitemap_xml=None,
        robots_txt=None,
        indexnow_key="abc123",
    )
    assert len(built) == 1
    assert built[0].file_path == "abc123.txt"
    assert built[0].after == "abc123"
    # We must not imply this reaches Google, it does not.
    assert "Google" in built[0].guidance


# --------------------------------------------------------------------------
# IndexNow
# --------------------------------------------------------------------------


def test_key_is_stable_and_scoped_to_org_and_host():
    a = indexnow.derive_key("org1", "https://example.com/")
    assert a == indexnow.derive_key("org1", "https://example.com/some/page")
    assert a != indexnow.derive_key("org2", "https://example.com/")
    assert a != indexnow.derive_key("org1", "https://other.com/")
    assert len(a) == 32 and a.isalnum()


def test_submission_refuses_until_the_key_file_is_published(monkeypatch):
    """Submitting without the key file would be rejected by the engines anyway;
    failing here lets us tell the user exactly what to do about it."""
    monkeypatch.setattr(indexnow, "fetch_text", lambda url: (404, ""))
    result = indexnow.submit("org1", "https://example.com/", ["https://example.com/a"])
    assert result["status"] == "unverified"
    assert result["submitted"] == 0
    assert result["key"] in result["reason"]


def test_submission_drops_urls_from_other_hosts(monkeypatch):
    key = indexnow.derive_key("org1", "https://example.com/")
    monkeypatch.setattr(indexnow, "fetch_text", lambda url: (200, key))
    posted = {}

    class Response:
        status_code = 200
        text = "ok"

    def fake_post(url, json, timeout):
        posted.update(json)
        return Response()

    monkeypatch.setattr(indexnow.httpx, "post", fake_post)
    result = indexnow.submit(
        "org1",
        "https://example.com/",
        ["https://example.com/a", "https://evil.com/b"],
    )
    assert result["status"] == "accepted"
    assert posted["urlList"] == ["https://example.com/a"]


def test_empty_submission_is_a_no_op():
    assert indexnow.submit("org1", "https://example.com/", [])["status"] == "skipped"


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def file_fix(**overrides) -> dict:
    base = {
        "findingCode": "missing_robots",
        "targetUrl": "https://example.com/robots.txt",
        "after": "User-agent: *\n",
    }
    base.update(overrides)
    return base


def test_file_fix_is_unverified_until_the_file_is_actually_served(monkeypatch):
    from godeye_engine.tasks import seo as seo_task

    monkeypatch.setattr(seo_task.crawler, "fetch_text", lambda url: (404, ""))
    ok, reason = seo_task._verify_file_fix(file_fix())
    assert not ok
    assert "404" in reason


def test_file_fix_verifies_when_the_file_is_there(monkeypatch):
    from godeye_engine.tasks import seo as seo_task

    monkeypatch.setattr(seo_task.crawler, "fetch_text", lambda url: (200, "User-agent: *\n"))
    ok, _ = seo_task._verify_file_fix(file_fix())
    assert ok


def test_a_sitemap_url_serving_html_is_not_a_sitemap(monkeypatch):
    """JS storefronts commonly answer /sitemap.xml with the app shell. Accepting
    a 200 alone would mark the fix verified while search engines still see
    nothing."""
    from godeye_engine.tasks import seo as seo_task

    monkeypatch.setattr(
        seo_task.crawler, "fetch_text", lambda url: (200, "<!doctype html><html></html>")
    )
    ok, reason = seo_task._verify_file_fix(
        file_fix(findingCode="missing_sitemap", targetUrl="https://example.com/sitemap.xml")
    )
    assert not ok
    assert "not an XML sitemap" in reason


def test_indexnow_key_file_must_contain_the_key(monkeypatch):
    from godeye_engine.tasks import seo as seo_task

    monkeypatch.setattr(seo_task.crawler, "fetch_text", lambda url: (200, "wrong-key"))
    ok, reason = seo_task._verify_file_fix(
        file_fix(findingCode="indexnow_key", after="right-key")
    )
    assert not ok
    assert "do not match" in reason


def test_site_wide_codes_are_not_page_verifiable():
    """Duplicate titles and broken links can only be judged by a full crawl, so
    verification must skip them rather than guess a verdict."""
    from godeye_engine.tasks import seo as seo_task

    assert "duplicate_title" not in seo_task.PAGE_LEVEL_CODES
    assert "broken_link" not in seo_task.PAGE_LEVEL_CODES
    assert "missing_description" in seo_task.PAGE_LEVEL_CODES
