"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TRIAL_HOURS } from "@godeye/shared";
import { GodeyeEmblem } from "@/components/logo";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { ThemeSwitch } from "./theme-switch";

/**
 * The marketing header.
 *
 * Transparent over the hero, then a glass pane with a hairline once the page
 * has moved. backdrop-filter is expensive, so the nav and the page's cards are
 * the only places it is used, and both inherit the existing
 * prefers-reduced-transparency fallback.
 *
 * The integration pages are NOT in this nav. They are reference pages a visitor
 * reaches when they want detail about one platform, which puts them with
 * Privacy and Terms in the footer rather than in the primary path.
 */
const SECTIONS = [
  { href: "/#what-it-does", label: "Product" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
] as const;

function Wordmark() {
  return (
    <Link
      href="/"
      className="inline-flex min-h-11 items-center gap-2.5 rounded text-primary"
      aria-label="GODEYE, home"
    >
      {/* The real crest, in its compact cut. `compact` exists precisely for
          chrome at this size: fewer rays and heavier strokes, because the full
          variant's 1px detail collapses into a smudge below about 32px. */}
      <GodeyeEmblem variant="compact" className="h-10 w-10 text-primary" />
      <span className="font-brand text-[17px] tracking-[0.2em]">GODEYE</span>
    </Link>
  );
}

export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const closeDrawer = useCallback(() => setDrawer(false), []);
  const drawerRef = useFocusTrap<HTMLDivElement>(drawer, closeDrawer);
  useScrollLock(drawer);

  /**
   * One passive listener, coalesced into an animation frame. A scroll handler
   * that does work on every event is the classic way to make a page that
   * animates beautifully and scrolls badly.
   */
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        // 4px, not 80. The header is translucent, so between 0 and the
        // threshold a headline scrolls UNDER it with no pane behind it and the
        // two sets of text overlap. The pane has to arrive the moment the page
        // moves at all.
        setScrolled(window.scrollY > 4);
        frame = 0;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-[--dur-mid] ${
        scrolled ? "m-glass-strong border-b border-subtle" : "border-b border-transparent"
      }`}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-[4.5rem] max-w-[1200px] items-center justify-between px-6"
      >
        <Wordmark />

        <div className="hidden items-center gap-7 md:flex">
          {SECTIONS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-11 items-center rounded text-[14px] text-secondary transition-colors hover:text-primary"
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <ThemeSwitch />
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-[14px] text-secondary transition-colors hover:text-primary"
          >
            Sign in
          </Link>
          <Link href="/register" className="btn-brand text-[14px]">
            Start free
          </Link>
        </div>

        <div className="flex items-center gap-1 md:hidden">
          <ThemeSwitch />
          {/* 44px minimum target, WCAG 2.5.5. */}
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Open menu"
            aria-expanded={drawer}
            className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-secondary"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </nav>

      {drawer ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={closeDrawer}
            className="absolute inset-0 bg-black/70"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            className="m-glass-strong absolute inset-y-0 right-0 flex w-[min(20rem,85vw)] flex-col gap-1 border-l border-subtle p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <Wordmark />
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Close menu"
                className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-secondary"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            {SECTIONS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeDrawer}
                className="rounded-lg px-3 py-3 text-[15px] text-secondary transition-colors hover:bg-elevated hover:text-primary"
              >
                {item.label}
              </Link>
            ))}

            <div className="mt-auto flex flex-col gap-2 border-t border-subtle pt-4">
              <Link
                href="/login"
                onClick={closeDrawer}
                className="rounded-lg px-3 py-3 text-center text-[15px] text-secondary"
              >
                Sign in
              </Link>
              <Link href="/register" onClick={closeDrawer} className="btn-brand">
                Start free for {TRIAL_HOURS} hours
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
