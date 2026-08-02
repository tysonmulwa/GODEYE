"""What a product post may say, for shops selling into the EU/UK.

These are not style preferences. Each case below maps to a rule that binds the
shop, and the point of testing them is that a model asked politely to avoid
them will still produce them sometimes.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from godeye_engine.products.compliance import (
    DISCOUNT_RULE,
    SCARCITY_RULE,
    check,
    format_price,
    is_publishable,
    price_is_confirmable,
)


class TestInventedScarcity:
    """UCPD Annex I bans false claims of limited time or stock outright — no
    balancing test. An import gives us "in stock" or nothing, never a count or
    a deadline, so every one of these is necessarily made up."""

    @pytest.mark.parametrize(
        "caption",
        [
            "Only 3 left in stock — grab yours",
            "Almost sold out!",
            "Selling fast, don't miss out",
            "Last chance to own these",
            "Hurry, these are going quickly",
            "Offer ends tonight",
            "Sale ends tomorrow",
            "Limited time only",
            "While stocks last",
            "These won't last long",
            "Act now",
        ],
    )
    def test_is_refused(self, caption):
        violations = check(caption)
        assert violations, f"allowed an invented scarcity claim: {caption!r}"
        assert violations[0].rule == SCARCITY_RULE

    def test_stating_real_stock_status_is_fine(self):
        """"In stock" is a fact the import actually carries."""
        assert is_publishable("In stock now at the link in bio.")


class TestDiscountClaims:
    """Omnibus Art. 6a: announcing a price reduction requires stating the
    lowest price of the previous 30 days. An imported catalogue has today's
    price and no history, so there is no lawful way to say any of this."""

    @pytest.mark.parametrize(
        "caption",
        [
            "20% off this week",
            "Was £99, now £59",
            "Now only 49.99",
            "Save €30 on every pair",
            "Half price today",
            "Reduced from our usual price",
            "Sale now on",
            "Below RRP",
        ],
    )
    def test_is_refused(self, caption):
        violations = check(caption)
        assert violations, f"allowed a discount claim: {caption!r}"
        assert violations[0].rule == DISCOUNT_RULE

    def test_stating_the_price_plainly_is_fine(self):
        assert is_publishable("Handmade leather boots, £129. Link in bio.")


class TestHashtags:
    """A claim does not stop being a claim for having been packed into a
    hashtag, and every pattern here keys on word boundaries a hashtag lacks."""

    @pytest.mark.parametrize(
        "tag", ["#SaleNowOn", "#LimitedTime", "#LastChance", "#50%Off", "#while_stocks_last"]
    )
    def test_a_run_together_claim_is_still_caught(self, tag):
        assert check(f"Great boots. {tag}"), f"slipped through: {tag}"

    def test_ordinary_hashtags_are_left_alone(self):
        assert is_publishable("Handmade in Nairobi. #Leather #ChelseaBoot #MadeToLast")


class TestNormalCopyStillPasses:
    """The filter has to leave ordinary marketing alone, or it is useless."""

    @pytest.mark.parametrize(
        "caption",
        [
            "Full-grain leather, stitched by hand. £129 — link in bio.",
            "Our Chelsea boot in oxblood. Built to be resoled, not replaced.",
            "New in: the canvas tote, KSh 1,200.",
            "Three colours, one shape that goes with everything. €89.",
        ],
    )
    def test_passes(self, caption):
        assert is_publishable(caption), check(caption)


class TestPriceFormatting:
    """1.234,56 is one thousand two hundred in Germany. Writing it the other
    way round reads as a typo to the customers this is aimed at."""

    def test_euro_uses_the_continental_convention_by_default(self):
        assert format_price(Decimal("1234.56"), "EUR") == "1.234,56 €"

    def test_french_euro_groups_with_a_narrow_no_break_space(self):
        """French typography groups with U+202F, not an ordinary space — and
        it must not break across lines in the middle of a number."""
        assert format_price(Decimal("1234.56"), "EUR", "fr") == "1 234,56 €"

    def test_irish_euro_leads_with_the_symbol(self):
        assert format_price(Decimal("1234.56"), "EUR", "ie") == "€1,234.56"

    def test_sterling_and_dollar(self):
        assert format_price(Decimal("1234.56"), "GBP") == "£1,234.56"
        assert format_price(Decimal("99"), "USD") == "$99"

    def test_a_word_shaped_symbol_takes_a_space_and_a_glyph_does_not(self):
        """"KSh8,500" runs the letters into the digits and reads as a typo;
        "£129" is correct exactly as it is."""
        assert format_price(Decimal("8500"), "KES") == "KSh 8,500"
        assert format_price(Decimal("129"), "GBP") == "£129"

    def test_swiss_francs_group_with_an_apostrophe(self):
        assert format_price(Decimal("1234.50"), "CHF") == "CHF 1'234.50"

    def test_nordic_and_polish_put_the_symbol_last(self):
        assert format_price(Decimal("1299"), "SEK") == "1 299 kr"
        assert format_price(Decimal("249.90"), "PLN") == "249,90 zł"

    def test_a_whole_amount_drops_the_decimals(self):
        """"£129" reads as a price; "£129.00" reads as a spreadsheet."""
        assert format_price(Decimal("129.00"), "GBP") == "£129"

    def test_an_unknown_currency_shows_its_code_rather_than_guessing(self):
        assert format_price(Decimal("500"), "XYZ") == "XYZ 500"

    def test_no_price_renders_nothing(self):
        """A caller must be able to omit the price, not print "None"."""
        assert format_price(None, "EUR") is None


class TestVatProvenance:
    """98/6/EC: a consumer price includes VAT, with no exception for adverts.
    A Shopify feed reports whatever the store is configured to report."""

    def test_a_price_from_the_product_page_can_be_published(self):
        for source in ("jsonld", "microdata", "opengraph"):
            assert price_is_confirmable(source)

    def test_a_price_from_the_shops_own_api_can_be_published(self):
        """It is the value the shop's own pages render to customers, read from
        the same API those pages call. Excluding it would drop the price from
        every post on exactly the sites this route exists to serve."""
        assert price_is_confirmable("storefront_api")

    def test_a_price_from_the_shopify_feed_needs_confirming(self):
        assert not price_is_confirmable("shopify")
