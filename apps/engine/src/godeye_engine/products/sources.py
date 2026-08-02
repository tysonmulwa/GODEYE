"""Find a shop's products, by whichever route that shop makes cheapest.

Three routes, tried in order of cost:

  Platform feed   Shopify publishes /products.json unauthenticated, with the
                  whole catalogue, real variants and full-size images. One
                  request beats crawling a hundred pages, and it is exact.
  Crawl           Follow the sitemap and on-page links to product pages, then
                  read the structured data each one publishes.
  Rendering       For storefronts that build their catalogue in the browser.
                  Not done here — this reports that it is needed.

The outcome carries a verdict as well as products, because "nothing found" has
two very different meanings. A storefront we cannot read without running its
JavaScript needs rendering turned on; a site that simply does not sell things
needs telling so, not retrying. Those are indistinguishable by count alone.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal
from urllib.parse import urljoin, urlparse

import httpx

from .extract import Product, extract_products, looks_client_rendered, parse_price

logger = logging.getLogger(__name__)

# Identify honestly. A shop owner reading their logs should be able to tell who
# this is and switch it off, and the consent prompt means they agreed to it.
USER_AGENT = "GODEYE/1.0 (+https://godeyeautomation.com/bot)"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "text/html,application/json"}

TIMEOUT = 25.0
MAX_PRODUCT_PAGES = 40

# Path shapes that mean "a product lives here" across the common platforms.
PRODUCT_PATH = re.compile(
    r"/(products?|product-page|item|shop|store|collections/[^/]+/products)/[^/]+/?$", re.I
)

# Verdicts. The caller shows a different thing for each, so they are values
# rather than a bare count.
FOUND = "found"
NEEDS_RENDERING = "needs_rendering"
NO_CATALOGUE = "no_catalogue"
UNREACHABLE = "unreachable"
# Refused rather than absent. Major storefronts sit behind CDN bot protection
# that answers 403 or 429 to anything it does not recognise, and it does so
# regardless of what the request calls itself. Worth separating: the site is
# fine, the owner can allow us through, and retrying harder will not help.
BLOCKED = "blocked"

BLOCKED_STATUSES = {401, 403, 429}


@dataclass
class ImportResult:
    verdict: str
    products: list[Product] = field(default_factory=list)
    pages_read: int = 0
    route: str = "crawl"
    detail: str | None = None

    @property
    def ok(self) -> bool:
        return self.verdict == FOUND


def _client() -> httpx.Client:
    return httpx.Client(headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)


def _origin(url: str) -> str:
    parts = urlparse(url if "://" in url else f"https://{url}")
    return f"{parts.scheme}://{parts.netloc}"


def shopify_feed(base_url: str, client: httpx.Client, limit: int = 250) -> list[Product] | None:
    """The whole catalogue in one request, when the shop is Shopify.

    Returns None when this is not a Shopify store. That has to be judged on the
    body, not the status: single-page storefronts answer 200 with their HTML
    shell for every path there is, so a 200 here means nothing on its own.
    """
    url = urljoin(_origin(base_url) + "/", f"products.json?limit={limit}")
    try:
        response = client.get(url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict) or "products" not in payload:
        return None

    products: list[Product] = []
    for item in payload.get("products") or []:
        if not isinstance(item, dict):
            continue
        title = (item.get("title") or "").strip()
        if not title:
            continue
        variants = [v for v in (item.get("variants") or []) if isinstance(v, dict)]
        images = [i.get("src") for i in (item.get("images") or []) if isinstance(i, dict)]
        available = any(v.get("available") for v in variants) if variants else None
        products.append(
            Product(
                title=title,
                url=urljoin(_origin(base_url) + "/", f"products/{item.get('handle', '')}"),
                description=_plain(item.get("body_html")),
                # Shopify sorts variants by position; the first is the one the
                # product page shows by default.
                price=parse_price(variants[0].get("price")) if variants else None,
                currency=None,  # products.json omits it; the shop's own pages carry it
                image_url=images[0] if images else None,
                availability=(
                    None if available is None else ("InStock" if available else "OutOfStock")
                ),
                sku=(variants[0].get("sku") or None) if variants else None,
                source="shopify",
            )
        )
    return products


def _plain(html: str | None) -> str | None:
    if not html:
        return None
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:2000] or None


def discover_product_urls(base_url: str, client: httpx.Client, limit: int) -> list[str]:
    """Product page URLs, from the sitemap where there is one and links where
    there is not."""
    origin = _origin(base_url)
    found: list[str] = []
    seen: set[str] = set()

    def consider(url: str) -> None:
        absolute = urljoin(origin + "/", url.strip())
        if urlparse(absolute).netloc != urlparse(origin).netloc:
            return
        absolute = absolute.split("#")[0]
        if absolute in seen or not PRODUCT_PATH.search(urlparse(absolute).path):
            return
        seen.add(absolute)
        found.append(absolute)

    for path in ("/sitemap.xml", "/sitemap_index.xml", "/product-sitemap.xml"):
        try:
            response = client.get(urljoin(origin + "/", path))
        except httpx.HTTPError:
            continue
        # A single-page app answers 200 with HTML for every path, so the body
        # decides whether this was really a sitemap.
        if response.status_code != 200 or "xml" not in response.headers.get("content-type", ""):
            continue
        locations = re.findall(r"<loc>\s*(.*?)\s*</loc>", response.text)
        # A sitemap index points at more sitemaps rather than at pages.
        for location in locations[:200]:
            if location.endswith(".xml"):
                try:
                    nested = client.get(location)
                except httpx.HTTPError:
                    continue
                for inner in re.findall(r"<loc>\s*(.*?)\s*</loc>", nested.text)[:500]:
                    consider(inner)
            else:
                consider(location)
        if len(found) >= limit:
            return found[:limit]

    if not found:
        try:
            home = client.get(origin)
            for href in re.findall(r'href=["\']([^"\']+)["\']', home.text):
                consider(href)
        except httpx.HTTPError:
            pass
    return found[:limit]


def import_from_site(url: str, limit: int = MAX_PRODUCT_PAGES) -> ImportResult:
    """Everything this shop is selling, and how it was found.

    Never raises: an unreachable site is an answer the user needs to see, not
    a traceback in a worker log.
    """
    origin = _origin(url)
    with _client() as client:
        try:
            home = client.get(origin)
        except httpx.HTTPError as e:
            return ImportResult(
                verdict=UNREACHABLE, detail=f"Could not reach {origin}: {type(e).__name__}"
            )
        if home.status_code in BLOCKED_STATUSES:
            return ImportResult(
                verdict=BLOCKED,
                detail=(
                    f"{origin} refused the request (HTTP {home.status_code}). Its CDN or "
                    f"firewall is turning away automated traffic. Allow the user agent "
                    f"'{USER_AGENT}' through, and the import will work — GODEYE identifies "
                    f"itself rather than pretending to be a browser, so it can be allowed."
                ),
            )
        if home.status_code >= 400:
            return ImportResult(
                verdict=UNREACHABLE, detail=f"{origin} returned HTTP {home.status_code}"
            )

        feed = shopify_feed(origin, client)
        if feed:
            logger.info("Products: %s is Shopify, read %d from its feed", origin, len(feed))
            return ImportResult(
                verdict=FOUND, products=feed, pages_read=1, route="shopify"
            )

        products: list[Product] = []
        seen: set[str] = set()
        pages = 0

        # The landing page is worth reading first: a single-product site, and
        # many small shops, put everything there.
        for candidate_html, candidate_url in [(home.text, origin)]:
            for product in extract_products(candidate_html, candidate_url):
                key = (product.sku or product.title).lower()
                if key not in seen:
                    seen.add(key)
                    products.append(product)
        pages += 1

        for product_url in discover_product_urls(origin, client, limit):
            try:
                page = client.get(product_url)
            except httpx.HTTPError:
                continue
            if page.status_code != 200:
                continue
            pages += 1
            for product in extract_products(page.text, product_url):
                key = (product.sku or product.title).lower()
                if key not in seen:
                    seen.add(key)
                    products.append(product)

        if products:
            return ImportResult(
                verdict=FOUND, products=products, pages_read=pages, route="crawl"
            )

        # Nothing found. Which of the two reasons decides what the user is told.
        if looks_client_rendered(home.text):
            rendered = _read_rendered(origin, client, limit)
            if rendered is not None:
                return rendered
        return ImportResult(
            verdict=NO_CATALOGUE,
            pages_read=pages,
            detail=(
                "No products were published on this site. Sites that are not shops "
                "have nothing to import, and this is the expected answer for them."
            ),
        )


def _read_rendered(origin: str, client: httpx.Client, limit: int) -> ImportResult | None:
    """Try again with a browser. None means keep the plain-fetch verdict.

    The links a catalogue needs are themselves drawn by the JavaScript, so the
    rendered landing page is what supplies them — discovering URLs from the
    empty shell first would find nothing to render.
    """
    from . import render

    if not render.is_configured():
        return ImportResult(verdict=NEEDS_RENDERING, route="render", detail=render.NOT_CONFIGURED)

    logger.info("Products: %s looks client-rendered, asking for a rendered copy", origin)
    home = render.render(origin)
    if not home.ok:
        return ImportResult(verdict=NEEDS_RENDERING, route="render", detail=home.detail)

    products: list[Product] = []
    seen: set[str] = set()
    for product in extract_products(home.html, origin):
        key = (product.sku or product.title).lower()
        if key not in seen:
            seen.add(key)
            products.append(product)
    pages = 1

    # Product links only exist once the page has run, so they are read from the
    # rendered copy rather than from the shell fetched earlier.
    for product_url in _links_in(home.html, origin)[:limit]:
        page = render.render(product_url)
        if not page.ok:
            continue
        pages += 1
        for product in extract_products(page.html, product_url):
            key = (product.sku or product.title).lower()
            if key not in seen:
                seen.add(key)
                products.append(product)

    if products:
        logger.info("Products: rendered %s, found %d", origin, len(products))
        return ImportResult(
            verdict=FOUND, products=products, pages_read=pages, route="render"
        )
    # Rendered successfully and still nothing: this one really has no catalogue.
    return ImportResult(
        verdict=NO_CATALOGUE,
        pages_read=pages,
        route="render",
        detail=(
            "The site was rendered in a browser and still published no products. "
            "Sites that are not shops have nothing to import."
        ),
    )


def _links_in(html: str, origin: str) -> list[str]:
    """Product-shaped links on an already-rendered page."""
    found: list[str] = []
    seen: set[str] = set()
    for href in re.findall(r'href=["\']([^"\']+)["\']', html):
        absolute = urljoin(origin + "/", href.strip()).split("#")[0]
        if urlparse(absolute).netloc != urlparse(origin).netloc:
            continue
        if absolute in seen or not PRODUCT_PATH.search(urlparse(absolute).path):
            continue
        seen.add(absolute)
        found.append(absolute)
    return found


def total_value(products: list[Product]) -> Decimal:
    """Catalogue value, for showing that an import found something real."""
    return sum((p.price for p in products if p.price is not None), Decimal("0"))
