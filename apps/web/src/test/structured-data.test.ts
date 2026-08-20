/**
 * The JSON-LD blocks, validated.
 *
 * Structured data is the kind of thing that is wrong for months without anybody
 * noticing. It is invisible on the page, and a search engine's response to
 * invalid markup is not to complain — it is to quietly stop showing the rich
 * result, which looks exactly like ordinary SEO weather.
 *
 * These rules exist because a proposed change to the Organization block would
 * have failed three of them at once. That is what they are for.
 */
import { describe, expect, it } from "vitest";
import { SITE_URL } from "../lib/site";
import { organizationJsonLd, softwareJsonLd } from "../lib/structured-data";

/** An https URL that is not merely a bare origin. */
const isDeepUrl = (value: string) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.pathname.length > 1;
};

describe("every block", () => {
  it.each([
    ["organization", organizationJsonLd],
    ["software", softwareJsonLd],
  ])("declares a context and a type for %s", (_label, block) => {
    expect(block["@context"]).toBe("https://schema.org");
    expect(block["@type"]).toBeTruthy();
  });

  it.each([
    ["organization", organizationJsonLd],
    ["software", softwareJsonLd],
  ])("serialises %s without breaking out of the script tag", (_label, block) => {
    // The blocks go into dangerouslySetInnerHTML. They are ours rather than
    // user input, but "ours today" is not a property that survives a refactor,
    // and `</script>` inside a JSON string ends the element early.
    expect(JSON.stringify(block)).not.toContain("</script");
    expect(JSON.stringify(block)).not.toContain("<!--");
  });

  it.each([
    ["organization", organizationJsonLd],
    ["software", softwareJsonLd],
  ])("points %s at the canonical site URL", (_label, block) => {
    expect(block.url).toBe(SITE_URL);
  });
});

describe("Organization", () => {
  it("claims only what is true", () => {
    expect(organizationJsonLd["@type"]).toBe("Organization");
    expect(organizationJsonLd.name).toBeTruthy();
    // aggregateRating, review, openingHours and address are all things Google
    // will show and none of them have anything real behind them yet. A rich
    // result is withdrawn for structured data that overstates, which costs more
    // than the result was worth.
    for (const overclaim of ["aggregateRating", "review", "openingHours", "address", "telephone"]) {
      expect(organizationJsonLd).not.toHaveProperty(overclaim);
    }
  });

  /**
   * `logo` must be an image. Pointing it at the site root — a document — makes
   * Google ignore the property and flag it in Search Console, so the block is
   * strictly worse than one that never claimed a logo.
   *
   * SVG is rejected too: Google does not accept it for `logo`, and `/icon.svg`
   * is the only mark this repo serves.
   */
  it("has no logo, or a logo that is actually an image", () => {
    const logo = (organizationJsonLd as { logo?: string }).logo;
    if (logo === undefined) return;
    expect(isDeepUrl(logo)).toBe(true);
    expect(logo).toMatch(/\.(png|jpg|jpeg|gif|webp)$/i);
  });

  /**
   * `sameAs` means "this other URL unambiguously identifies this
   * organization". A platform's front page identifies the platform, not us:
   * `https://instagram.com` is a false claim, and it is the exact shape the
   * placeholder version of this block had.
   */
  it("has no sameAs, or a sameAs listing real profiles", () => {
    const sameAs = (organizationJsonLd as { sameAs?: string[] }).sameAs;
    if (sameAs === undefined) return;

    const bareHosts = [
      "instagram.com",
      "linkedin.com",
      "facebook.com",
      "x.com",
      "twitter.com",
      "tiktok.com",
      "youtube.com",
    ];
    for (const entry of sameAs) {
      expect(isDeepUrl(entry)).toBe(true);
      // A profile has a path. A bare origin, with or without a trailing slash,
      // is the platform itself.
      expect(bareHosts).not.toContain(new URL(entry).hostname.replace(/^www\./, ""));
      expect(new URL(entry).pathname).not.toBe("/");
    }
    expect(new Set(sameAs).size).toBe(sameAs.length);
  });
});

describe("SoftwareApplication", () => {
  it("describes an application, not a company", () => {
    expect(softwareJsonLd["@type"]).toBe("SoftwareApplication");
    expect(softwareJsonLd.applicationCategory).toBeTruthy();
    expect(softwareJsonLd.operatingSystem).toBeTruthy();
  });

  it("offers at least one plan", () => {
    expect(softwareJsonLd.offers.length).toBeGreaterThan(0);
  });

  /**
   * Prices come from the same catalogue that seeds the database and renders the
   * pricing page, so an advertised price cannot drift from a charged one. That
   * failure mode is both a bad search result and a false claim about money.
   */
  it.each(softwareJsonLd.offers)("states $name as a currency amount", (offer) => {
    expect(offer["@type"]).toBe("Offer");
    // "19" and "19.5" are both accepted by schema.org and both display badly.
    expect(offer.price).toMatch(/^\d+\.\d{2}$/);
    expect(offer.priceCurrency).toMatch(/^[A-Z]{3}$/);
    expect(offer.url).toBe(`${SITE_URL}/pricing`);
  });

  it("names every plan exactly once", () => {
    const names = softwareJsonLd.offers.map((offer) => offer.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
