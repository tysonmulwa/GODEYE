import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Lists the pages worth indexing, so search engines find them without
 * following links — which matters most on a site whose navigation is drawn by
 * JavaScript, as this one's is.
 *
 * Only public pages. The application behind the login has nothing a crawler
 * can reach.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/login`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/register`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}
