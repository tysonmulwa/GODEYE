/**
 * Where this site lives, for the tags that need an absolute URL.
 *
 * Canonical links, Open Graph URLs, the sitemap and JSON-LD all have to name
 * the site in full, a relative path in any of them is either ignored or read
 * as a different site. One constant so they cannot disagree with each other,
 * which is its own SEO problem.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://godeyeautomation.com"
).replace(/\/$/, "");

export const SITE_NAME = "GODEYE";

export const SITE_DESCRIPTION =
  "Connect your business. Set your goals. GODEYE's AI agents handle content, " +
  "publishing, SEO, and growth.";
