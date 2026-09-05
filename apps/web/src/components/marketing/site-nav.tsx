"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * The mobile drawer is a SIBLING of <header>, never a child, and that is
 * load-bearing rather than tidiness. An element with `backdrop-filter` becomes
 * the containing block for `position: fixed` descendants, exactly as
 * `transform` does. The header only carries `m-glass-strong` once the page has
 * moved, so a drawer nested inside it was full-screen at the top of the page
 * and, after a single scroll, resolved `inset-0` against the header's 4.5rem
 * box instead of the viewport: the black backdrop covered only that strip and
 * the menu sat unreadable on top of the hero. Same markup, correct at one
 * scroll position and broken at every other, which is what made it survive.
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

  const sentinel = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => setDrawer(false), []);
  const drawerRef = useFocusTrap<HTMLDivElement>(drawer, closeDrawer);
  useScrollLock(drawer);

  /**
   * Has the page moved? Answered by watching a 1px sentinel, not by reading a
   * scroll offset.
   *
   * `window.scrollY` is ALWAYS 0 on this site. globals.css sets
   * `html, body { height: 100%; overflow-x: hidden }` to stop a wide table
   * pushing the page sideways, and that combination makes <body> the scrolling
   * element: scroll to the footer and `document.body.scrollTop` reads 4000+
   * while `window.scrollY` and `documentElement.scrollTop` both read 0.
   *
   * So the previous scroll listener never fired, `scrolled` never became true,
   * the header never got its pane, and every section slid underneath a fully
   * transparent bar — which is exactly the overlap that was reported.
   *
   * A sentinel sidesteps the question entirely: it does not care which element
   * scrolls, it costs no scroll handler, and it cannot be broken again by a
   * change to overflow somewhere else in the stylesheet.
   */
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting), {
      threshold: 0,
    });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <>
      {/* Sits in normal flow at the very top of the page, so it scrolls away
          while the header stays put. Its leaving the viewport IS "the page has
          moved". */}
      <div ref={sentinel} aria-hidden className="absolute top-0 h-px w-full" />
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

      </header>
      {drawer ? (
        <div className="fixed inset-0 z-[60] md:hidden">
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
    </>
  );
}
