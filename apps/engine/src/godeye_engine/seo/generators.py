"""sitemap.xml and robots.txt generation from crawl results."""

from __future__ import annotations

from datetime import date
from urllib.parse import urlparse
from xml.sax.saxutils import escape

from .crawler import CrawlResult


def generate_sitemap(result: CrawlResult) -> str:
    today = date.today().isoformat()
    root = result.start_url
    entries = []
    seen: set[str] = set()
    for page in result.pages:
        if page.status_code != 200 or page.url in seen:
            continue
        if page.meta_robots and "noindex" in page.meta_robots.lower():
            continue
        seen.add(page.url)
        priority = "1.0" if page.url == root else "0.7"
        entries.append(
            "  <url>\n"
            f"    <loc>{escape(page.url)}</loc>\n"
            f"    <lastmod>{today}</lastmod>\n"
            f"    <priority>{priority}</priority>\n"
            "  </url>"
        )
    body = "\n".join(entries)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}\n"
        "</urlset>\n"
    )


def generate_robots(start_url: str) -> str:
    parsed = urlparse(start_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        "# Block common non-content paths (adjust to your site)\n"
        "Disallow: /admin/\n"
        "Disallow: /cart/\n"
        "Disallow: /checkout/\n"
        "\n"
        f"Sitemap: {base}/sitemap.xml\n"
    )
