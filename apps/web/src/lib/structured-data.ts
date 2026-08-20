import { PLANS } from "@godeye/shared";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "./site";

/**
 * The JSON-LD blocks the root layout renders.
 *
 * Moved out of `layout.tsx` so they can be validated. A server component that
 * calls `next/font` cannot be imported into a test, and structured data is
 * exactly the kind of thing that is wrong for months without anybody noticing:
 * it is invisible on the page, and a search engine's response to invalid markup
 * is to quietly stop showing the rich result rather than to complain.
 */

/**
 * Describes the business in the form search engines read directly, rather than
 * inferring. In the root layout so it is on every page.
 *
 * Only claims that are true: a name, what it does, and where it lives. Rich
 * results are withdrawn for structured data that overstates, so ratings and
 * opening hours stay out until there is something real behind them.
 *
 * ## `logo` and `sameAs` are deliberately absent
 *
 * Both were proposed, in this shape:
 *
 *     logo: "https://godeyeautomation.com",
 *     sameAs: ["https://instagram.com", "https://linkedin.com"]
 *
 * Neither is usable, and adding them would be worse than the omission:
 *
 *   - `logo` has to be an **image** URL. The site root is a document, so
 *     Google ignores the property and reports it as invalid in Search Console.
 *     There is also no raster logo in this repo to point at — `/icon.svg` is an
 *     SVG, which Google does not accept for `logo`, and `/opengraph-image` is a
 *     1200x630 share card rather than a mark.
 *   - `sameAs` means "this other URL unambiguously identifies this
 *     organization". `https://instagram.com` is Instagram's front page, not a
 *     GODEYE profile, so the claim is simply false — and false structured data
 *     is the thing the paragraph above says was engineered against.
 *
 * They belong here the moment there are real values: a raster logo the site
 * serves, and the actual profile URLs. Enforced by structured-data.test.ts, so
 * the placeholder version cannot land by accident.
 */
export const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
};

/**
 * What the product is and what it costs, in the form a search engine reads.
 *
 * The Organization block alone says a company exists; it says nothing about
 * software, price or plan, so nothing could be shown as a product result. The
 * offers are built from the same catalogue that seeds the database and renders
 * the pricing page, so a price cannot be advertised here that nobody is
 * charged, which is the failure mode worth engineering against, since it is
 * both a bad search result and a false claim.
 */
export const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: PLANS.map((plan) => ({
    "@type": "Offer",
    name: plan.name,
    price: plan.priceMonthlyUsd.toFixed(2),
    priceCurrency: "USD",
    description: plan.tagline,
    url: `${SITE_URL}/pricing`,
  })),
};
