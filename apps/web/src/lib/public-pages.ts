/**
 * The public pages, in one place.
 *
 * The sitemap was written by hand and had already fallen behind: /pricing and
 * both integration pages existed for days with nothing pointing a search engine
 * at them. A page that is not in the sitemap and not linked from the homepage
 * is, for practical purposes, not published. Listing them here means adding a
 * page and forgetting to announce it takes deliberate effort.
 */

export interface PublicPage {
  path: string;
  /** Sitemap priority, 0 to 1. The homepage is the only 1. */
  priority: number;
  changeFrequency: "weekly" | "monthly" | "yearly";
}

export const PUBLIC_PAGES: PublicPage[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
  { path: "/integrations/tiktok", priority: 0.7, changeFrequency: "monthly" },
  { path: "/integrations/meta", priority: 0.7, changeFrequency: "monthly" },
  { path: "/register", priority: 0.5, changeFrequency: "yearly" },
  { path: "/login", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.2, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.2, changeFrequency: "yearly" },
];

/**
 * Everything behind the login. Crawling these puts a login screen into the
 * results under a dashboard's name, so they are disallowed rather than merely
 * unlinked.
 */
export const PRIVATE_PATHS = [
  "/dashboard",
  "/composer",
  "/autopilot",
  "/calendar",
  "/connections",
  "/seo",
  "/settings",
  "/team",
  "/billing",
  "/onboarding",
  "/invite/",
];
