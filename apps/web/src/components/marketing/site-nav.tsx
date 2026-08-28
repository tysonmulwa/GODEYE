"use client";

import { Menu, X, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TRIAL_HOURS } from "@godeye/shared";
import { GodeyeMark } from "@/components/logo";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useScrollLock } from "@/lib/use-scroll-lock";

/**
 * The marketing header.
 *
 * Transparent over the hero, then a blurred panel with a hairline once the page
 * has moved. `backdrop-filter` is expensive — globals.css says so — so this is
 * the only element on the marketing pages that uses it, and it inherits the
 * app's existing `prefers-reduced-transparency` fallback for free.
 */

const SECTIONS = [
  { href: "/#what-it-does", label: "Product" },
  { href: "/#how-it-works", label: "How it works" },
] as const;

/**
 * There is no `/docs` route, so the nav does not claim one. These two pages
 * exist and were previously reachable only from the footer.
 */
const INTEGRATIONS = [
  { href: "/integrations/tiktok", label: "TikTok" },
  { href: "/integrations/meta", label: "Facebook & Instagram" },
] as const;

function Wordmark() {
  return (
    <Link
      href="/"
      className="inline-flex min-h-11 items-center gap-2.5 rounded text-primary"
      aria-label="GODEYE, home"
    >
      <GodeyeMark className="h-7 w-7 text-violet" />
      <span className="font-brand text-[15px] tracking-[0.2em]">GODEYE</span>
    </Link>
  );
}

/** Desktop-only disclosure for the two integration pages. */
function IntegrationsMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // A menu that only closes by clicking the trigger again is a menu that
    // stays open over the content the visitor moved on to read.
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 items-center gap-1 rounded text-[14px] text-secondary transition-colors hover:text-primary"
      >
        Integrations
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-[--dur-fast] ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="hairline absolute left-1/2 top-[calc(100%+0.75rem)] w-60 -translate-x-1/2 rounded-xl bg-elevated p-1.5">
          {INTEGRATIONS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-[14px] text-secondary transition-colors hover:bg-raised hover:text-primary"
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
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
        setScrolled(window.scrollY > 80);
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
      className={`sticky top-0 z-50 transition-colors duration-[--dur-mid] ${
        scrolled ? "glass-strong border-b border-subtle" : "border-b border-transparent"
      }`}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6"
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
          <IntegrationsMenu />
          <Link
            href="/pricing"
            className="flex min-h-11 items-center rounded text-[14px] text-secondary transition-colors hover:text-primary"
          >
            Pricing
          </Link>
        </div>

        <div className="hidden items-center gap-3 md:flex">
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

        {/* 44px minimum target — WCAG 2.5.8. */}
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          aria-expanded={drawer}
          className="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-secondary md:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
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
            className="absolute inset-y-0 right-0 flex w-[min(20rem,85vw)] flex-col gap-1 border-l border-subtle bg-raised p-5"
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

            {[...SECTIONS, { href: "/pricing", label: "Pricing" }, ...INTEGRATIONS].map((item) => (
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
              <Link href="/register" onClick={closeDrawer} className="btn-brand justify-center">
                Start free for {TRIAL_HOURS} hours
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
