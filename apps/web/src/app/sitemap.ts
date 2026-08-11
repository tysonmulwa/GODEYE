import type { MetadataRoute } from "next";
import { PUBLIC_PAGES } from "@/lib/public-pages";
import { SITE_URL } from "@/lib/site";

/**
 * Lists the pages worth indexing, so search engines find them without
 * following links — which matters most on a site whose navigation is drawn by
 * JavaScript, as this one's is.
 *
 * The list itself lives in lib/public-pages.ts rather than here, because when
 * it was written out by hand it fell behind: /pricing and both integration
 * pages were live for days with nothing pointing a crawler at them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return PUBLIC_PAGES.map((page) => ({
    url: `${SITE_URL}${page.path}`,
    lastModified: now,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
