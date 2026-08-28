import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteNav } from "@/components/marketing/site-nav";

/**
 * The public, logged-out pages: the homepage and pricing.
 *
 * A route group, so it adds a shared shell without changing a single URL —
 * `/` and `/pricing` are exactly where they were.
 *
 * ## Why the dark palette lives here and not on <html>
 *
 * The app is light by default and flips to dark by adding `.dark` to the
 * document element from a `useEffect` in `theme-toggle.tsx`. Building a
 * dark-first marketing page on that would be wrong twice over: the class lands
 * after first paint, so every cold load would flash white, and the page would
 * invert entirely for any visitor who had set the *dashboard* to light.
 *
 * So `.marketing` carries its own palette, on its own wrapper, and never
 * consults `.dark`. There is no theme switch out here. The token layer is in
 * globals.css and documented in docs/design/tokens.md.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing relative min-h-svh font-sans">
      {/*
       * 2.4.1 Bypass Blocks. First focusable thing on the page, visible only
       * once focused. The same pattern as the dashboard's layout — a keyboard
       * user should not have to walk the whole nav on every page.
       */}
      <a
        href="#main"
        className="sr-only rounded-lg bg-elevated px-4 py-2 text-primary focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60]"
      >
        Skip to main content
      </a>

      <SiteNav />

      {/* -1 so the skip link can move focus here without putting <main> into
          the tab order itself. */}
      <main id="main" tabIndex={-1}>
        {children}
      </main>

      <SiteFooter />
    </div>
  );
}
