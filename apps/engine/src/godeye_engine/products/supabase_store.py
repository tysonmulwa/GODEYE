"""Read a storefront through the same public API its own pages use.

A shop built as a single-page app fetches its catalogue from somewhere, and on
a large number of custom storefronts that somewhere is Supabase. The address
and the anonymous key are compiled into the JavaScript every visitor already
downloads, they have to be, or the site could not load, and the key is
publishable by design, with row-level security deciding what it may read.

So for these shops there is a route that is better than rendering in every
way: exact values instead of values parsed out of markup, one request instead
of a browser per page, and no monthly bill for a Chromium container. It is the
same idea as reading Shopify's /products.json, pointed at a different backend.

Only ever used on a workspace's own site, which it has given consent for, and
only ever reading what that site already serves to anyone who opens it.
"""

from __future__ import annotations

import logging
import re
from decimal import Decimal
from urllib.parse import urljoin

import httpx

from ..security import EgressBlocked, SafeClient
from .extract import Product, parse_price

logger = logging.getLogger(__name__)

# The project URL and the anon key as they appear in a compiled bundle. The
# key is a JWT, so it is recognisable without knowing the project.
_PROJECT_URL = re.compile(r"https://([a-z0-9]{16,32})\.supabase\.co")
_ANON_KEY = re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b")
# supabase-js reads a table as .from("products"); the bundle keeps the literal.
_TABLE = re.compile(r"""\.from\(\s*["']([a-z_][a-z0-9_]{2,40})["']\s*\)""")

# Tables worth trying, in the order a storefront is likely to name them.
_LIKELY_TABLES = ("products", "product", "items", "catalog", "catalogue", "listings")

# Never mistake these for a catalogue.
_NOT_CATALOGUE = {
    "cart_items", "wishlists", "user_roles", "notifications", "orders",
    "order_items", "profiles", "users", "store_settings", "settings",
    "categories", "reviews", "addresses", "payments",
}

TIMEOUT = 20.0

# Column names differ from shop to shop. Read in order of preference.
_TITLE = ("name", "title", "product_name", "productName")
_DESCRIPTION = ("description", "details", "summary", "body", "long_description")
_PRICE = ("price", "selling_price", "unit_price", "amount", "cost")
# What the shop says it used to cost. Kept as evidence; whether a post may
# state it depends on where the shop sells.
_WAS_PRICE = ("original_price", "compare_at_price", "was_price", "list_price", "msrp")
_CURRENCY = ("currency", "currency_code", "currencyCode")
_IMAGE = ("image_url", "imageUrl", "image", "thumbnail", "photo", "cover_image", "images")
_SKU = ("sku", "code", "product_code", "barcode")
_SLUG = ("slug", "handle", "id")
_SIZES = ("sizes", "size", "available_sizes", "variants")
_COLOURS = ("colors", "colours", "color", "colour", "available_colors")
_CATEGORY = ("category", "product_type", "type", "shoe_type", "subcategory")
_STOCK = ("in_stock", "inStock", "available", "is_available", "stock", "quantity", "stock_count")


class Backend:
    """Where a storefront keeps its catalogue."""

    def __init__(self, url: str, key: str, tables: list[str]):
        self.url = url
        self.key = key
        self.tables = tables

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Backend({self.url}, tables={self.tables})"


def discover(html: str, origin: str, client: SafeClient) -> Backend | None:
    """Find the backend a page's own scripts talk to, or None.

    The bundle is where this lives, not the HTML: the page is a mount point and
    the configuration is compiled into the JavaScript beside it.
    """
    sources = [html]
    for src in re.findall(r'<script[^>]+src=["\']([^"\']+\.js[^"\']*)["\']', html)[:4]:
        if "challenge-platform" in src:  # a CDN's bot check, not the shop's code
            continue
        try:
            response = client.get(urljoin(origin + "/", src), timeout=TIMEOUT)
        except (httpx.HTTPError, EgressBlocked):
            continue
        if response.status_code == 200:
            sources.append(response.text)

    for source in sources:
        project = _PROJECT_URL.search(source)
        key = _ANON_KEY.search(source)
        if not project or not key:
            continue
        tables = [
            name
            for name in dict.fromkeys(_TABLE.findall(source))
            if name not in _NOT_CATALOGUE
        ]
        # Prefer a name that sounds like a catalogue; fall back to whatever the
        # bundle mentioned, since a shop may call its table something else.
        ordered = [t for t in _LIKELY_TABLES if t in tables] + [
            t for t in tables if t not in _LIKELY_TABLES
        ]
        if not ordered:
            ordered = list(_LIKELY_TABLES)
        return Backend(url=project.group(0), key=key.group(0), tables=ordered[:4])
    return None


def fetch_products(backend: Backend, origin: str, limit: int = 100) -> list[Product]:
    """Read the catalogue table, trying the likeliest names in turn."""
    headers = {"apikey": backend.key, "Authorization": f"Bearer {backend.key}"}
    # A fourth SSRF sink, and the least obvious one: `backend.url` is scraped
    # out of the customer's own page HTML, so it is attacker-controlled in
    # exactly the way S-3's URL is. Found while wiring the egress guard, not in
    # the original audit.
    with SafeClient(headers=headers, total_timeout=TIMEOUT) as client:
        for table in backend.tables:
            try:
                response = client.get(
                    f"{backend.url}/rest/v1/{table}",
                    params={"select": "*", "limit": str(limit)},
                )
            except (httpx.HTTPError, EgressBlocked) as e:
                logger.info("Supabase read of %s failed: %s", table, type(e).__name__)
                continue
            if response.status_code != 200:
                # 404 is the wrong table; 401 means this one is not public,
                # which is the shop's choice and not an error to report loudly.
                continue
            try:
                rows = response.json()
            except ValueError:
                continue
            if not isinstance(rows, list) or not rows:
                continue

            products = [p for p in (_to_product(row, origin) for row in rows) if p]
            if products:
                logger.info(
                    "Supabase: read %d product(s) from %s", len(products), table
                )
                return products
    return []


def _pick(row: dict, names: tuple[str, ...]):
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return None


def _image_of(row: dict, origin: str) -> str | None:
    value = _pick(row, _IMAGE)
    if isinstance(value, list):
        value = next((v for v in value if v), None)
    if isinstance(value, dict):
        value = value.get("url") or value.get("src")
    if not value:
        return None
    return urljoin(origin + "/", str(value))


def _availability_of(row: dict) -> str | None:
    """Only reported when the row actually says. Guessing "in stock" would put
    a claim in a post that nothing supports."""
    value = _pick(row, _STOCK)
    if value is None:
        return None
    if isinstance(value, bool):
        return "InStock" if value else "OutOfStock"
    if isinstance(value, (int, float, Decimal)):
        return "InStock" if value > 0 else "OutOfStock"
    text = str(value).strip().lower()
    if text in ("true", "yes", "available", "in_stock", "in stock", "active"):
        return "InStock"
    if text in ("false", "no", "sold_out", "sold out", "out_of_stock", "unavailable"):
        return "OutOfStock"
    return None


def _to_product(row, origin: str) -> Product | None:
    if not isinstance(row, dict):
        return None
    title = _pick(row, _TITLE)
    if not title:
        return None
    slug = _pick(row, _SLUG)
    return Product(
        title=str(title)[:500],
        # A product page the shop actually serves, so a post can link to it.
        url=urljoin(origin + "/", f"product/{slug}") if slug else origin,
        description=str(_pick(row, _DESCRIPTION))[:2000] if _pick(row, _DESCRIPTION) else None,
        price=parse_price(_pick(row, _PRICE)),
        compare_at_price=parse_price(_pick(row, _WAS_PRICE)),
        currency=(str(_pick(row, _CURRENCY)).upper() if _pick(row, _CURRENCY) else None),
        image_url=_image_of(row, origin),
        availability=_availability_of(row),
        sku=str(_pick(row, _SKU)) if _pick(row, _SKU) else None,
        # Its own source: this is the shop's own database value, not a price
        # parsed out of markup, so it is as trustworthy as a product page.
        source="storefront_api",
        variants=_variants_of(row),
    )


def _variants_of(row: dict) -> dict:
    """Sizes, colours and category, when the shop records them.

    These are what let a post answer "will it fit me, does it come in black"
    without the reader opening the link, and the shop already knows.
    """
    found: dict = {}
    for key, names in (("sizes", _SIZES), ("colours", _COLOURS)):
        value = _pick(row, names)
        if isinstance(value, list):
            items = [str(v).strip() for v in value if str(v).strip()]
        elif isinstance(value, str):
            items = [part.strip() for part in re.split(r"[,;/|]", value) if part.strip()]
        else:
            items = []
        if items:
            found[key] = items[:12]
    category = _pick(row, _CATEGORY)
    if category and not isinstance(category, (list, dict)):
        found["category"] = str(category).strip()
    return found
