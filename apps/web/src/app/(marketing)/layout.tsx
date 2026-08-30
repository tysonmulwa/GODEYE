import { Constellation } from "@/components/marketing/constellation";
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
 * consults `.dark`. It has its own switch instead (ThemeSwitch), which writes
 * `data-theme` on this element; with nothing written the CSS falls back to
 * `prefers-color-scheme`, so a first visit matches the machine with no flash
 * and no JavaScript. The token layer is in globals.css and documented in
 * docs/design/tokens.md.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    // `isolate` is load-bearing. Without a stacking context here the
    // constellation's negative z-index escapes to the root, where it lands
    // BEHIND the propagated body background and is invisible. With it, the
    // canvas paints above this element's own background and below content.
    <div className="marketing relative isolate min-h-svh font-sans">
      {/* Fixed, behind everything, and the only thing on the page that is not
          content. It reads the palette off this scope, so it follows the theme
          switch without being re-created. */}
      <Constellation />

      {/*
       * 2.4.1 Bypass Blocks. First focusable thing on the page, visible only
       * once focused. The same pattern as the dashboard's layout: a keyboard
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
