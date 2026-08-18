import type { MetadataRoute } from "next";
import { PRIVATE_PATHS } from "@/lib/public-pages";
import { SITE_URL } from "@/lib/site";

/**
 * Generated rather than a static file, so the sitemap URL cannot drift from
 * the domain the site is actually served on.
 *
 * The disallowed paths are the signed-in application. There is nothing there
 * for a crawler, every page needs a session, and letting them be indexed
 * puts a login screen in the results under a dashboard's name.
 *
 * The AI crawlers are named and allowed on purpose. They are already permitted
 * by the wildcard, but buyers increasingly ask an assistant rather than a
 * search box, and being quotable there is worth more to GODEYE than the
 * content is worth withholding. Naming them makes that a decision on the
 * record, so tightening the wildcard later cannot silently reverse it.
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "ClaudeBot",
  "Claude-Web",
  "Google-Extended",
  "Applebot-Extended",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: PRIVATE_PATHS,
      })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
