"""What a product post may and may not say, for shops selling into the EU/UK.

This is not house style. Three rules below are law in every EU member state,
and a post that breaks them exposes the shop — our customer — not us:

  Omnibus Directive, Article 6a
      Any announcement of a price reduction must state the lowest price the
      trader charged in the preceding 30 days. The Commission's guidance and
      the CJEU both read this as covering general announcements such as "Sale
      now on", and it applies on social media, not only on the product page.
      An imported catalogue carries today's price and no history, so there is
      no lawful way to announce a discount from it. The generator must not
      produce that language at all.

  Price Indication Directive 98/6/EC, Article 2(a)
      The selling price shown to a consumer is the final price including VAT
      and all other taxes, and there is no exception for advertising. Prices
      read from a Shopify /products.json feed are whatever the store is
      configured to report and may exclude tax, so a price from that route is
      marked as needing confirmation rather than published blind.

  Unfair Commercial Practices Directive, Annex I
      Falsely stating a product is available only for a very limited time, or
      that stock is nearly gone, to force an immediate decision is blacklisted
      -- banned in all circumstances, with no balancing test. An import gives
      us "in stock" or "out of stock" and never a quantity or a deadline, so
      any such claim in a generated post is necessarily invented.

A model told to avoid these will still produce them occasionally, which is why
the check here is a deterministic filter over the finished text rather than an
instruction in a prompt. The prompt asks; this decides.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

# ---------------------------------------------------------------- violations


@dataclass(frozen=True)
class Violation:
    rule: str
    matched: str
    explanation: str


# Invented scarcity and deadlines. Blacklisted outright, so these are refusals
# rather than warnings.
SCARCITY_PATTERNS: list[tuple[re.Pattern, str]] = [
    (
        re.compile(r"\bonly\s+\d+\s+(left|remaining|in stock|available)\b", re.I),
        "a stock count we do not have",
    ),
    (
        re.compile(r"\b(almost|nearly)\s+(sold\s?out|gone)\b", re.I),
        "a stock level we do not have",
    ),
    (re.compile(r"\bselling\s+fast\b", re.I), "a sales rate we do not have"),
    (re.compile(r"\blast\s+(chance|few|one|\d+)\b", re.I), "a stock claim we cannot verify"),
    (re.compile(r"\bhurry\b", re.I), "urgency with no deadline behind it"),
    (
        re.compile(r"\b(ends|offer ends|sale ends)\s+(today|tonight|soon|tomorrow|in\b)", re.I),
        "a deadline we do not have",
    ),
    (re.compile(r"\b(limited|while stocks?)\s+(time|offer|stock|last)\w*\b", re.I),
     "limited availability we cannot verify"),
    (re.compile(r"\bwon'?t last\b", re.I), "a scarcity claim we cannot verify"),
    (re.compile(r"\bact\s+(now|fast)\b", re.I), "manufactured urgency"),
    (re.compile(r"\bcountdown\b", re.I), "a deadline we do not have"),
]

# Discount language. Lawful only alongside the 30-day low, which an import
# cannot supply.
DISCOUNT_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b\d{1,3}\s?%\s*(off|discount|reduction)\b", re.I), "a discount claim"),
    (re.compile(r"\bwas\s*[£$€]\s?\d", re.I), "a former price we do not hold"),
    (re.compile(r"\b(now\s+only|reduced|marked\s+down|slashed)\b", re.I), "a reduction claim"),
    (re.compile(r"\bsave\s*[£$€]?\s?\d", re.I), "a saving we cannot substantiate"),
    (re.compile(r"\b(sale|deal|offer)\s+(now\s+on|of the\s+\w+)\b", re.I), "a sale announcement"),
    (re.compile(r"\bhalf\s+price\b", re.I), "a reduction claim"),
    (re.compile(r"\bbargain\s+price\b", re.I), "a reduction claim"),
    (re.compile(r"\bRRP\b"), "a reference price we do not hold"),
]

SCARCITY_RULE = "UCPD Annex I — invented scarcity or deadline"
DISCOUNT_RULE = "Omnibus Art. 6a — price reduction without the 30-day low"


_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def expand_hashtags(text: str) -> str:
    """Put the spaces back into run-together words.

    Every pattern here keys on word boundaries, and a hashtag has none:
    #SaleNowOn makes exactly the claim "sale now on" does and would otherwise
    pass untouched. Splitting on the lower-to-upper boundary recovers it.
    """
    return _CAMEL_BOUNDARY.sub(" ", text.replace("#", " ").replace("_", " "))


def check(text: str) -> list[Violation]:
    """Every rule the finished text breaks. Empty means it may be published."""
    # Checked as written and as read: a claim does not stop being a claim for
    # having been packed into a hashtag.
    candidates = {text, expand_hashtags(text)}
    found: list[Violation] = []
    seen: set[str] = set()
    for patterns, rule in ((SCARCITY_PATTERNS, SCARCITY_RULE), (DISCOUNT_PATTERNS, DISCOUNT_RULE)):
        for pattern, explanation in patterns:
            for candidate in candidates:
                match = pattern.search(candidate)
                if match and match.group(0).lower() not in seen:
                    seen.add(match.group(0).lower())
                    found.append(
                        Violation(rule=rule, matched=match.group(0), explanation=explanation)
                    )
                    break
    return found


def is_publishable(text: str) -> bool:
    return not check(text)


# ------------------------------------------------------------------- pricing

# How a price is written where it is being read. Getting this wrong reads as
# amateur to exactly the customers this is aimed at: 1.234,56 in Germany is
# one thousand two hundred, and 1,234.56 there looks like a typo.
#
# (symbol, position, thousands separator, decimal separator)
_FORMATS: dict[str, tuple[str, str, str, str]] = {
    "EUR": ("€", "suffix", ".", ","),   # DE/NL/ES/IT convention, the commonest
    "GBP": ("£", "prefix", ",", "."),
    "USD": ("$", "prefix", ",", "."),
    "CHF": ("CHF", "prefix", "'", "."),
    "SEK": ("kr", "suffix", " ", ","),
    "NOK": ("kr", "suffix", " ", ","),
    "DKK": ("kr", "suffix", ".", ","),
    "PLN": ("zł", "suffix", " ", ","),
    "CZK": ("Kč", "suffix", " ", ","),
    "KES": ("KSh", "prefix", ",", "."),
    "ZAR": ("R", "prefix", ",", "."),
    "AUD": ("$", "prefix", ",", "."),
    "CAD": ("$", "prefix", ",", "."),
}

# France and Ireland share the euro but not its typography.
_LOCALE_OVERRIDES: dict[str, tuple[str, str, str, str]] = {
    "fr": ("€", "suffix", " ", ","),  # narrow no-break space
    "ie": ("€", "prefix", ",", "."),
    "en": ("€", "prefix", ",", "."),
}


def format_price(amount: Decimal | float | int | None, currency: str | None,
                 locale: str | None = None) -> str | None:
    """A price written the way its market writes it.

    Returns None when there is no price, so a caller renders nothing rather
    than "None" or a bare zero.
    """
    if amount is None:
        return None
    value = Decimal(str(amount))
    code = (currency or "").upper()

    fmt = _FORMATS.get(code)
    if code == "EUR" and locale:
        fmt = _LOCALE_OVERRIDES.get(locale.lower()[:2], fmt)
    if fmt is None:
        # An unknown currency is still a price; show the code so it is
        # unambiguous rather than guessing at a symbol.
        symbol, position, thousands, decimal_point = (code or "", "prefix", ",", ".")
    else:
        symbol, position, thousands, decimal_point = fmt

    whole, _, fraction = f"{value:.2f}".partition(".")
    negative = whole.startswith("-")
    whole = whole.lstrip("-")
    grouped = ""
    while len(whole) > 3:
        grouped = thousands + whole[-3:] + grouped
        whole = whole[:-3]
    grouped = whole + grouped

    # Whole amounts read better without the trailing zeros in a caption.
    body = grouped if fraction == "00" else f"{grouped}{decimal_point}{fraction}"
    if negative:
        body = "-" + body

    if not symbol:
        return body
    if position != "prefix":
        return f"{body} {symbol}"
    # A word-shaped symbol takes a space; a single glyph does not. "KSh 8,500"
    # and "CHF 1'234", but "£129" and "$99" — running the letters into the
    # digits reads as a typo.
    separator = " " if symbol[-1].isalpha() else ""
    return f"{symbol}{separator}{body}"


# Plenty of shops store a price without storing a currency — their own site
# knows which one it means because it only ever sells in one. A bare "8500" in
# a caption does not, so the workspace's own stated location fills the gap.
_CURRENCY_BY_PLACE: list[tuple[tuple[str, ...], str]] = [
    (("united kingdom", "britain", "england", "scotland", "wales", " uk"), "GBP"),
    (("ireland",), "EUR"),
    (("united states", "usa", " us,", "america"), "USD"),
    (("switzerland",), "CHF"),
    (("sweden",), "SEK"),
    (("norway",), "NOK"),
    (("denmark",), "DKK"),
    (("poland",), "PLN"),
    (("czech",), "CZK"),
    (("canada",), "CAD"),
    (("australia",), "AUD"),
    (("kenya", "nairobi"), "KES"),
    (("south africa",), "ZAR"),
    (("nigeria",), "NGN"),
    (("united arab emirates", "dubai"), "AED"),
    (
        ("germany", "france", "spain", "italy", "netherlands", "belgium", "austria",
         "portugal", "finland", "greece", "estonia", "latvia", "lithuania",
         "slovakia", "slovenia", "croatia", "luxembourg", "malta", "cyprus"),
        "EUR",
    ),
]


def currency_for_location(location: str | None) -> str | None:
    """The currency a shop in this place almost certainly quotes in.

    A guess, so it is only ever a fallback for a shop that did not record one.
    Nothing here changes the number — only how it is labelled — and labelling
    it wrongly is still better than publishing a bare figure with no unit.
    """
    if not location:
        return None
    text = f" {location.lower()}, "
    for needles, code in _CURRENCY_BY_PLACE:
        if any(needle in text for needle in needles):
            return code
    return None


# Routes whose price is the one a shopper sees on the page, tax included.
# storefront_api belongs here: it is the value the shop's own pages render to
# customers, read from the same API those pages call, so it carries exactly the
# standing of a price in the page's structured data. The Shopify feed is the
# odd one out — that figure is a store configuration setting, not necessarily
# what anybody is shown.
TAX_INCLUSIVE_SOURCES = {"jsonld", "microdata", "opengraph", "storefront_api"}


def price_is_confirmable(source: str) -> bool:
    """Whether a price can be published without the shop confirming it.

    Structured data on a product page is the consumer-facing price, which
    98/6/EC requires to include VAT. A Shopify /products.json figure is
    whatever the store is configured to report and may exclude tax, so it is
    fast to import and not safe to advertise unchecked.
    """
    return source in TAX_INCLUSIVE_SOURCES


def describe(violations: list[Violation]) -> str:
    """One line a person can act on, for a log or the UI."""
    if not violations:
        return "compliant"
    return "; ".join(f"{v.matched!r} ({v.explanation})" for v in violations)
