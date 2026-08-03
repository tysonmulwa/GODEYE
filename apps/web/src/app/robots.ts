import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Generated rather than a static file, so the sitemap URL cannot drift from
 * the domain the site is actually served on.
 *
 * The disallowed paths are the signed-in application. There is nothing there
 * for a crawler — every page needs a session — and letting them be indexed
 * puts a login screen in the results under a dashboard's name.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/composer", "/autopilot", "/calendar", "/connections",
                 "/seo", "/settings", "/team", "/onboarding", "/invite/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
