"""Read a shop's products off its own pages.

Stores publish their catalogue in machine-readable form because search engines
require it, so this reads what is already there rather than guessing at layout.
Three sources, in order of how much they can be trusted:

  JSON-LD    schema.org/Product in a <script type="application/ld+json">.
             What Shopify, WooCommerce, BigCommerce and most Western storefronts
             emit by default, and the only one that carries a currency reliably.
  Microdata  the same vocabulary expressed as itemprop attributes. Older themes.
  OpenGraph  og:type=product. Coarse — one product per page, no stock, and the
             price is often missing — but present when nothing else is.

Nothing here renders JavaScript. A storefront that builds its catalogue in the
browser returns an empty shell to a plain fetch, and the honest answer for those
is that no products were found rather than a page of guesses.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from urllib.parse import urljoin

from bs4 import BeautifulSoup

# A shop page names its own currency; guessing from a symbol shared by a dozen
# countries would put the wrong one on a post.
CURRENCY_SYMBOLS = {"$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR"}

MAX_DESCRIPTION = 2000


@dataclass
class Product:
    """One product as the shop describes it."""

    title: str
    url: str
    description: str | None = None
    price: Decimal | None = None
    currency: str | None = None
    image_url: str | None = None
    availability: str | None = None
    sku: str | None = None
    source: str = "jsonld"
    # What the shop itself says about the thing, beyond name and price. Sizes,
    # colours and a category are what turn "Sports Shoes, KES 1,999" into a
    # post someone can act on without opening the link.
    variants: dict = field(default_factory=dict)
    extras: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "description": self.description,
            "price": str(self.price) if self.price is not None else None,
            "currency": self.currency,
            "imageUrl": self.image_url,
            "availability": self.availability,
            "sku": self.sku,
            "source": self.source,
        }


def parse_price(raw) -> Decimal | None:
    """A price as a number, from the many shapes a shop writes one in.

    "KSh 1,200.00", "1.299,00", "$45" and 45.0 all have to land on the same
    kind of value, and anything that is not a price at all has to return None
    rather than a plausible wrong number.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float, Decimal)):
        try:
            value = Decimal(str(raw))
        except InvalidOperation:
            return None
        return value if value >= 0 else None

    text = str(raw).strip()
    if not text:
        return None
    # Keep digits and separators; drop currency words, symbols and spaces.
    cleaned = re.sub(r"[^\d.,-]", "", text)
    if not re.search(r"\d", cleaned):
        return None

    # 1.299,00 is one thousand two hundred and ninety nine, not 1.299.
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        decimals = cleaned.split(",")[-1]
        # A trailing group of exactly three digits is a thousands separator.
        cleaned = cleaned.replace(",", "." if len(decimals) != 3 else "")

    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return None
    return value if value >= 0 else None


def _currency_from(text: str | None) -> str | None:
    if not text:
        return None
    code = re.search(r"\b([A-Z]{3})\b", text)
    if code:
        return code.group(1)
    for symbol, iso in CURRENCY_SYMBOLS.items():
        if symbol in text:
            return iso
    return None


def _clean(text) -> str | None:
    if not text:
        return None
    # Descriptions arrive with markup and runs of whitespace from the CMS.
    plain = re.sub(r"<[^>]+>", " ", str(text))
    plain = re.sub(r"\s+", " ", plain).strip()
    return plain[:MAX_DESCRIPTION] or None


def _first(value):
    """schema.org lets almost any field be a value or a list of them."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _image_from(node, base_url: str) -> str | None:
    image = _first(node.get("image"))
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl")
    return urljoin(base_url, str(image)) if image else None


def _offer_of(node) -> dict:
    offers = _first(node.get("offers"))
    if isinstance(offers, dict):
        # AggregateOffer states a range; the low price is the honest headline.
        if offers.get("@type") == "AggregateOffer":
            return {
                "price": offers.get("lowPrice") or offers.get("price"),
                "priceCurrency": offers.get("priceCurrency"),
                "availability": offers.get("availability"),
            }
        return offers
    return {}


def _iter_jsonld_nodes(data):
    """Walk one JSON-LD document, which may nest products several ways."""
    if isinstance(data, list):
        for item in data:
            yield from _iter_jsonld_nodes(item)
        return
    if not isinstance(data, dict):
        return
    yield data
    for key in ("@graph", "itemListElement", "item", "mainEntity", "hasVariant"):
        if key in data:
            yield from _iter_jsonld_nodes(data[key])


def _is_product(node: dict) -> bool:
    types = node.get("@type")
    types = types if isinstance(types, list) else [types]
    return any(str(t).lower() in ("product", "productmodel") for t in types if t)


def from_jsonld(html: str, base_url: str) -> list[Product]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[Product] = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = script.string or script.get_text() or ""
        try:
            data = json.loads(raw)
        except ValueError:
            # A single malformed block must not cost the rest of the page.
            continue
        for node in _iter_jsonld_nodes(data):
            if not _is_product(node):
                continue
            title = _clean(_first(node.get("name")))
            if not title:
                continue
            offer = _offer_of(node)
            url = node.get("url") or offer.get("url") or base_url
            found.append(
                Product(
                    title=title,
                    url=urljoin(base_url, str(url)),
                    description=_clean(node.get("description")),
                    price=parse_price(offer.get("price")),
                    currency=offer.get("priceCurrency") or _currency_from(str(offer.get("price"))),
                    image_url=_image_from(node, base_url),
                    availability=_availability(offer.get("availability")),
                    sku=_clean(node.get("sku") or node.get("mpn")),
                    source="jsonld",
                )
            )
    return found


def _availability(raw) -> str | None:
    if not raw:
        return None
    # schema.org writes these as URLs: http://schema.org/InStock
    return str(raw).rstrip("/").split("/")[-1] or None


def from_microdata(html: str, base_url: str) -> list[Product]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[Product] = []
    scopes = soup.find_all(attrs={"itemtype": re.compile(r"schema\.org/Product", re.I)})
    for scope in scopes:
        def prop(name: str, _scope=None) -> str | None:
            node = (_scope or scope).find(attrs={"itemprop": name})
            if node is None:
                return None
            # Machine-readable value first: content= is unlocalised.
            for attribute in ("content", "src", "href"):
                value = node.get(attribute)
                if value:
                    return value
            return node.get_text(strip=True)

        title = _clean(prop("name"))
        if not title:
            continue
        price = parse_price(prop("price"))
        found.append(
            Product(
                title=title,
                url=urljoin(base_url, prop("url") or base_url),
                description=_clean(prop("description")),
                price=price,
                currency=prop("priceCurrency") or _currency_from(prop("price")),
                image_url=urljoin(base_url, prop("image")) if prop("image") else None,
                availability=_availability(prop("availability")),
                sku=_clean(prop("sku")),
                source="microdata",
            )
        )
    return found


def from_opengraph(html: str, base_url: str) -> list[Product]:
    soup = BeautifulSoup(html, "html.parser")
    tags: dict[str, str] = {}
    for meta in soup.find_all("meta"):
        key = meta.get("property") or meta.get("name")
        content = meta.get("content")
        if key and content:
            tags[key.lower()] = content

    if "product" not in (tags.get("og:type") or "").lower():
        return []
    title = _clean(tags.get("og:title"))
    if not title:
        return []
    return [
        Product(
            title=title,
            url=urljoin(base_url, tags.get("og:url") or base_url),
            description=_clean(tags.get("og:description")),
            price=parse_price(
                tags.get("product:price:amount") or tags.get("og:price:amount")
            ),
            currency=tags.get("product:price:currency") or tags.get("og:price:currency"),
            image_url=urljoin(base_url, tags["og:image"]) if tags.get("og:image") else None,
            availability=_availability(tags.get("product:availability")),
            source="opengraph",
        )
    ]


def extract_products(html: str, base_url: str) -> list[Product]:
    """Every product this page describes, best source first.

    The three sources overlap — a Shopify page emits JSON-LD and OpenGraph for
    the same item — so later sources only fill gaps the earlier ones left.
    """
    products = from_jsonld(html, base_url)
    seen: set[str] = set()
    for product in products:
        seen |= _identity_keys(product)

    for candidate in from_microdata(html, base_url) + from_opengraph(html, base_url):
        keys = _identity_keys(candidate)
        if keys & seen:
            continue
        products.append(candidate)
        seen |= keys
    return products


def _identity_keys(product: Product) -> set[str]:
    """Everything that could identify this product, for matching across sources.

    A match on any one of them is a match. Picking a single key does not work:
    the same Shopify item carries a SKU in its JSON-LD and none in its
    OpenGraph tags, so comparing "sku or title" compared a SKU against a title
    and listed one product twice.
    """
    keys = set()
    for value in (product.sku, product.title, product.url):
        if value and str(value).strip():
            keys.add(str(value).strip().lower())
    return keys


def looks_client_rendered(html: str) -> bool:
    """Whether a page's content arrives later, in the browser.

    Worth telling apart from a shop that genuinely has nothing listed: one is
    a site we cannot read without running its JavaScript, the other is an
    answer. A storefront shell is small, and it is mostly script tags.
    """
    if len(html) > 120_000:
        return False
    soup = BeautifulSoup(html, "html.parser")
    body = soup.find("body")
    text = body.get_text(strip=True) if body else ""
    # An empty mount point is the actual evidence. Short body text on its own
    # is not: a real WooCommerce product page came to 117 KB with 1127
    # characters of it, because the weight is markup rather than prose, and
    # "has a script tag" matches essentially every page on the web. Together
    # those sent a fully server-rendered shop off to be rendered again.
    roots = soup.find_all(attrs={"id": re.compile(r"^(root|app|__next)$")}) + soup.find_all(
        attrs={"data-reactroot": True}
    )
    return bool(roots) and len(text) < 1500
