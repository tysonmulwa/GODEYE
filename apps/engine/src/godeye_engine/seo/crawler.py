"""Polite same-domain crawler — collects the page facts the audit rules need."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
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


def crawl(start_url: str, max_pages: int = 20, progress=None) -> CrawlResult:
    """BFS crawl of same-domain pages with broken-link detection."""
    start = normalize_url(start_url)
    queue: list[str] = [start]
    seen: set[str] = {start}
    pages: list[PageData] = []
    linked_from: dict[str, set[str]] = {}
    broken: dict[str, list[str]] = {}

    client = httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=TIMEOUT,
        follow_redirects=True,
    )
    try:
        while queue and len(pages) < max_pages:
            url = queue.pop(0)
            if progress:
                progress(len(pages) + 1, url)
            started = time.monotonic()
            try:
                response = client.get(url)
            except httpx.HTTPError as e:
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
            pages.append(page)

            for link in page.internal_links:
                linked_from.setdefault(link, set()).add(url)
                if link not in seen and len(seen) < max_pages * 4:
                    seen.add(link)
                    queue.append(link)

            time.sleep(REQUEST_DELAY_SEC)

        # robots.txt / sitemap.xml checks
        root = urlparse(start)
        base = f"{root.scheme}://{root.netloc}"
        has_robots = False
        has_sitemap = False
        try:
            has_robots = client.get(f"{base}/robots.txt").status_code == 200
        except httpx.HTTPError:
            pass
        try:
            has_sitemap = client.get(f"{base}/sitemap.xml").status_code == 200
        except httpx.HTTPError:
            pass
    finally:
        client.close()

    return CrawlResult(
        start_url=start,
        pages=pages,
        broken_links=broken,
        has_robots_txt=has_robots,
        has_sitemap_xml=has_sitemap,
    )
