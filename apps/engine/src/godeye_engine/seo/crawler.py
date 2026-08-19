"""Polite same-domain crawler, collects the page facts the audit rules need."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urldefrag, urljoin, urlparse

import httpx

from ..security import EgressBlocked, SafeClient
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

USER_AGENT = "GODEYE-SEO-Bot/0.1 (+https://godeye.app)"
REQUEST_DELAY_SEC = 0.5
TIMEOUT = 15.0


@dataclass
class PageData:
    url: str
    status_code: int
    response_time_ms: int
    title: str | None = None
    meta_description: str | None = None
    canonical: str | None = None
    meta_robots: str | None = None
    h1s: list[str] = field(default_factory=list)
    h2_count: int = 0
    word_count: int = 0
    images_total: int = 0
    images_missing_alt: int = 0
    # src of each image lacking alt text, a count alone isn't actionable, the
    # user needs to know which images to describe.
    images_without_alt: list[str] = field(default_factory=list)
    internal_links: list[str] = field(default_factory=list)
    external_links_count: int = 0
    has_og_tags: bool = False
    has_json_ld: bool = False
    is_https: bool = False
    content_type: str = ""


@dataclass
class CrawlResult:
    start_url: str
    pages: list[PageData]
    broken_links: dict[str, list[str]]  # broken URL -> pages that link to it
    has_robots_txt: bool = False
    has_sitemap_xml: bool = False
    platform: str = "html"  # detected stack, see detect_platform()


# Ordered most-specific first: WooCommerce is WordPress, so it has to win before
# the generic WordPress signals match. Covers the platforms small businesses
# actually use across the US, UK and the EU. Shopware, PrestaShop and TYPO3 are
# marginal globally but common in DE/FR, and a fix written for the wrong stack is
# worse than no fix at all.
PLATFORM_SIGNALS: list[tuple[str, tuple[str, ...]]] = [
    ("woocommerce", ("woocommerce", "wc-ajax", "wp-content/plugins/woocommerce")),
    ("wordpress", ('name="generator" content="WordPress', "/wp-content/", "/wp-json/", "wp-includes")),
    ("shopify", ("cdn.shopify.com", "Shopify.theme", "myshopify.com", "shopify-features")),
    ("wix", ("wixstatic.com", "wix.com", "_wixCssStates", "wixapps")),
    ("squarespace", ("squarespace.com", "static1.squarespace.com", "Squarespace.afterBodyLoad")),
    ("webflow", ('name="generator" content="Webflow', "assets.website-files.com", "webflow.js")),
    ("shopware", ("/bundles/storefront/", "sw-storefront", "shopware.min.js")),
    ("prestashop", ("prestashop", "/modules/ps_", 'name="generator" content="PrestaShop')),
    ("magento", ("Magento_", "/static/frontend/", "mage/cookies")),
    ("bigcommerce", ("cdn11.bigcommerce.com", "bigcommerce.com/s-")),
    ("typo3", ('name="generator" content="TYPO3', "/typo3conf/", "/typo3temp/")),
    ("drupal", ('name="generator" content="Drupal', "/sites/default/files/", "drupal-settings-json")),
    ("joomla", ('name="generator" content="Joomla', "/media/jui/", "option=com_")),
    ("ghost", ('name="generator" content="Ghost', "/ghost/api/", "ghost-sdk")),
    ("nextjs", ("/_next/static/", "__NEXT_DATA__")),
    ("nuxt", ("__NUXT__", "/_nuxt/")),
    ("gatsby", ("___gatsby", "/page-data/app-data.json")),
    ("astro", ('name="generator" content="Astro', "astro-island")),
    ("hugo", ('name="generator" content="Hugo',)),
    ("jekyll", ('name="generator" content="Jekyll',)),
    ("framer", ("framerusercontent.com", 'name="generator" content="Framer')),
]


def detect_platform(html: str, headers: dict[str, str] | None = None) -> str:
    """Best-effort identification of the CMS/framework serving a page.

    Fix instructions are worthless unless they name the screen the user is
    actually looking at ("Yoast → SEO title" vs "Search engine listing → Edit"),
    so every audit resolves the stack once and every fix is written for it.
    Falls back to ``"html"``, whose instructions assume hand-edited markup.
    """
    lowered = html[:200_000].lower()
    for platform, signals in PLATFORM_SIGNALS:
        if any(signal.lower() in lowered for signal in signals):
            return platform

    # Headers are a weaker but occasionally decisive signal (Shopify and Wix both
    # announce themselves there even when the HTML is a bare JS shell).
    joined = " ".join(f"{k}: {v}" for k, v in (headers or {}).items()).lower()
    for platform in ("shopify", "wix", "squarespace", "wordpress"):
        if platform in joined:
            return platform
    return "html"


def normalize_url(url: str, base: str | None = None) -> str:
    """Resolve relative URLs, drop fragments, and strip trailing slashes."""
    if base:
        url = urljoin(base, url)
    url, _ = urldefrag(url)
    parsed = urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    normalized = f"{parsed.scheme}://{parsed.netloc}{path}"
    if parsed.query:
        normalized += f"?{parsed.query}"
    return normalized


def same_domain(url: str, root: str) -> bool:
    a, b = urlparse(url).netloc.lower(), urlparse(root).netloc.lower()
    return a == b or a == f"www.{b}" or b == f"www.{a}"


def parse_page(url: str, html: str, status_code: int, response_time_ms: int) -> PageData:
    soup = BeautifulSoup(html, "html.parser")
    page = PageData(
        url=url,
        status_code=status_code,
        response_time_ms=response_time_ms,
        is_https=url.startswith("https://"),
    )

    if soup.title and soup.title.string:
        page.title = soup.title.string.strip()
    description = soup.find("meta", attrs={"name": "description"})
    if description and description.get("content"):
        page.meta_description = description["content"].strip()
    canonical = soup.find("link", attrs={"rel": "canonical"})
    if canonical and canonical.get("href"):
        page.canonical = canonical["href"].strip()
    robots = soup.find("meta", attrs={"name": "robots"})
    if robots and robots.get("content"):
        page.meta_robots = robots["content"].strip()

    page.h1s = [h.get_text(strip=True) for h in soup.find_all("h1")]
    page.h2_count = len(soup.find_all("h2"))
    page.has_og_tags = soup.find("meta", attrs={"property": "og:title"}) is not None
    page.has_json_ld = soup.find("script", attrs={"type": "application/ld+json"}) is not None

    for img in soup.find_all("img"):
        page.images_total += 1
        if not (img.get("alt") or "").strip():
            page.images_missing_alt += 1
            src = (img.get("src") or img.get("data-src") or "").strip()
            if src and len(page.images_without_alt) < 25:
                page.images_without_alt.append(normalize_url(src, base=url))

    body = soup.find("body")
    if body:
        page.word_count = len(body.get_text(separator=" ", strip=True).split())

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = normalize_url(href, base=url)
        if not absolute.startswith(("http://", "https://")):
            continue
        if same_domain(absolute, url):
            page.internal_links.append(absolute)
        else:
            page.external_links_count += 1

    return page


_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)


def _fetch_locs(client: SafeClient, url: str) -> list[str] | None:
    """<loc> entries from an XML sitemap, or None if the URL isn't a real sitemap.

    Guards against sites that answer /sitemap.xml with an HTML shell (a common
    JS-storefront behaviour), those have no ``<loc`` and are ignored.
    """
    try:
        resp = client.get(url)
    except (httpx.HTTPError, EgressBlocked):
        return None
    if resp.status_code != 200 or "<loc" not in resp.text.lower():
        return None
    return _LOC_RE.findall(resp.text)


def _discover_sitemaps(client: SafeClient, base: str) -> list[str]:
    """Candidate sitemap URLs: those declared in robots.txt, then common paths."""
    candidates: list[str] = []
    try:
        robots = client.get(f"{base}/robots.txt")
        if robots.status_code == 200:
            candidates += re.findall(r"(?im)^\s*sitemap:\s*(\S+)", robots.text)
    except (httpx.HTTPError, EgressBlocked):
        pass
    candidates += [f"{base}/sitemap.xml", f"{base}/sitemap_index.xml"]
    seen: set[str] = set()
    return [u for u in candidates if not (u in seen or seen.add(u))]


def _sitemap_urls(client: SafeClient, base: str, limit: int = 80) -> list[str]:
    """Page URLs from the site's sitemap(s), follows one level of index nesting.

    Modern sites (Shopify, headless/JS storefronts) render navigation with
    JavaScript, so a static-HTML crawl finds almost no internal links. The XML
    sitemap is the reliable way to discover their real pages for a deep audit.
    """
    urls: list[str] = []
    for sitemap_url in _discover_sitemaps(client, base):
        if len(urls) >= limit:
            break
        locs = _fetch_locs(client, sitemap_url)
        if not locs:
            continue
        nested = [u for u in locs if u.lower().rstrip("/").endswith(".xml")]
        urls.extend(u for u in locs if u not in nested)
        for child in nested[:8]:
            if len(urls) >= limit:
                break
            child_locs = _fetch_locs(client, child)
            if child_locs:
                urls.extend(child_locs)
    # de-dupe while preserving order
    seen: set[str] = set()
    return [u for u in urls if not (u in seen or seen.add(u))][:limit]


def fetch_pages(urls: list[str], limit: int = 25) -> dict[str, PageData]:
    """Fetch a specific set of URLs and parse each one, keyed by requested URL.

    Verification only cares about the handful of pages a fix touched, so it uses
    this instead of ``crawl``, a second full BFS would hammer the customer's
    site to re-check three meta tags. Unreachable URLs are simply absent from the
    result; the caller decides what a missing page means.
    """
    out: dict[str, PageData] = {}
    # SafeClient, not httpx: every URL here came from a customer, and three of
    # them (the audit start URL, a sitemap <loc>, a page link) are attacker
    # controlled. See security/egress.py — findings S-2 and S-20.
    client = SafeClient(headers={"User-Agent": USER_AGENT}, total_timeout=TIMEOUT)
    try:
        for url in urls[:limit]:
            started = time.monotonic()
            try:
                response = client.get(url)
            except (httpx.HTTPError, EgressBlocked) as e:
                logger.info("Verification fetch failed for %s: %s", url, e)
                continue
            if response.status_code >= 400:
                continue
            if "text/html" not in response.headers.get("content-type", ""):
                continue
            page = parse_page(
                str(response.url),
                response.text,
                response.status_code,
                int((time.monotonic() - started) * 1000),
            )
            out[url] = page
            time.sleep(REQUEST_DELAY_SEC)
    finally:
        client.close()
    return out


def fetch_text(url: str) -> tuple[int, str]:
    """GET a plain-text resource (robots.txt, an IndexNow key file). (status, body)."""
    try:
        with SafeClient(headers={"User-Agent": USER_AGENT}, total_timeout=TIMEOUT) as client:
            response = client.get(url)
            return response.status_code, response.text
    except (httpx.HTTPError, EgressBlocked) as e:
        logger.info("Fetch failed for %s: %s", url, e)
        return 0, ""


def crawl(start_url: str, max_pages: int = 20, progress=None) -> CrawlResult:
    """BFS crawl of same-domain pages with broken-link detection."""
    start = normalize_url(start_url)
    queue: list[str] = [start]
    seen: set[str] = {start}
    pages: list[PageData] = []
    linked_from: dict[str, set[str]] = {}
    broken: dict[str, list[str]] = {}
    platform = "html"

    client = SafeClient(headers={"User-Agent": USER_AGENT}, total_timeout=TIMEOUT)
    try:
        root = urlparse(start)
        base = f"{root.scheme}://{root.netloc}"

        # Seed from sitemap.xml so sites whose navigation is JS-rendered still get a
        # deep crawl (static HTML alone often surfaces almost no internal links).
        sitemap_seed = _sitemap_urls(client, base)
        has_sitemap = bool(sitemap_seed)
        for raw in sitemap_seed:
            candidate = normalize_url(raw)
            if (
                same_domain(candidate, start)
                and candidate not in seen
                and len(seen) < max_pages * 4
            ):
                seen.add(candidate)
                queue.append(candidate)

        while queue and len(pages) < max_pages:
            url = queue.pop(0)
            if progress:
                progress(len(pages) + 1, url)
            started = time.monotonic()
            try:
                response = client.get(url)
            except (httpx.HTTPError, EgressBlocked) as e:
                logger.info("Fetch failed for %s: %s", url, e)
                broken.setdefault(url, sorted(linked_from.get(url, {"(start)"})))
                continue
            elapsed_ms = int((time.monotonic() - started) * 1000)

            if response.status_code >= 400:
                broken.setdefault(url, sorted(linked_from.get(url, {"(start)"})))
                continue

            content_type = response.headers.get("content-type", "")
            if "text/html" not in content_type:
                continue

            page = parse_page(str(response.url), response.text, response.status_code, elapsed_ms)
            page.content_type = content_type
            if not pages:
                # Resolve the stack once, from the first real page we get.
                platform = detect_platform(response.text, dict(response.headers))
            pages.append(page)

            for link in page.internal_links:
                linked_from.setdefault(link, set()).add(url)
                if link not in seen and len(seen) < max_pages * 4:
                    seen.add(link)
                    queue.append(link)

            time.sleep(REQUEST_DELAY_SEC)

        # robots.txt presence (sitemap presence already determined during seeding)
        has_robots = False
        try:
            has_robots = client.get(f"{base}/robots.txt").status_code == 200
        except (httpx.HTTPError, EgressBlocked):
            pass
    finally:
        client.close()

    return CrawlResult(
        start_url=start,
        pages=pages,
        broken_links=broken,
        has_robots_txt=has_robots,
        has_sitemap_xml=has_sitemap,
        platform=platform,
    )
