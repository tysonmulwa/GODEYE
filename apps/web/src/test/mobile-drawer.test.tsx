/**
 * The mobile menu must not live inside anything that blurs its backdrop.
 *
 * Reported from a phone: the drawer looked right with the page at the top and,
 * after scrolling, opened as text floating unreadably over the hero with no
 * panel behind it.
 *
 * The cause is a CSS rule with no visible warning. An element with
 * `backdrop-filter` becomes the containing block for `position: fixed`
 * descendants, exactly as `transform` does. `<header>` only gains
 * `m-glass-strong` -- and therefore `backdrop-filter: blur(36px)` -- once the
 * page has moved. So a drawer nested inside the header resolved `inset-0`
 * against the viewport at scroll position zero, and against the header's
 * 4.5rem box everywhere else: the `bg-black/70` backdrop covered only that
 * strip, and the panel had no ground to sit on.
 *
 * Identical markup, correct at one scroll position and broken at every other,
 * which is exactly why it shipped.
 *
 * These assert the containment rule rather than today's markup, so wrapping the
 * drawer in some future glass container fails here instead of on a phone.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SiteNav } from "@/components/marketing/site-nav";

/** Classes in globals.css that apply backdrop-filter. */
const BLURRING = ["m-glass", "m-glass-strong"];

const realObserver = window.IntersectionObserver;
afterEach(() => {
  Object.defineProperty(window, "IntersectionObserver", {
    writable: true,
    value: realObserver,
  });
});

/**
 * Open the drawer with the page SCROLLED, which is the state that broke.
 *
 * The shared setup stubs IntersectionObserver as a no-op, so `scrolled` never
 * becomes true and the header never gains `m-glass-strong` -- which would make
 * the assertions below pass without ever seeing the blur that causes the bug.
 * This captures the observer's callback and fires it, so the header is in the
 * same state a phone puts it in after one scroll.
 */
async function openDrawer({ scrolled = true } = {}) {
  const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  Object.defineProperty(window, "IntersectionObserver", {
    writable: true,
    value: class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  });

  const user = userEvent.setup();
  render(<SiteNav />);

  if (scrolled) {
    act(() => callbacks.forEach((cb) => cb([{ isIntersecting: false }])));
    // The premise. If the header stops using a blurring class when scrolled,
    // this fails loudly rather than quietly testing nothing.
    const header = document.querySelector("header")!;
    expect(BLURRING.some((cls) => header.classList.contains(cls))).toBe(true);
  }

  await user.click(screen.getByRole("button", { name: /open menu/i }));
  return screen.getByRole("dialog", { name: /main navigation/i });
}

describe("the mobile drawer escapes the header's stacking context", () => {
  it("is not rendered inside the header", async () => {
    const drawer = await openDrawer();
    const header = document.querySelector("header");

    expect(header).not.toBeNull();
    expect(header!.contains(drawer)).toBe(false);
  });

  it("has no ancestor that applies backdrop-filter", async () => {
    // The general rule. `header` is today's offender; any blurring wrapper
    // would break it the same way, and this catches that one too.
    const drawer = await openDrawer();

    const offenders: string[] = [];
    for (let node = drawer.parentElement; node; node = node.parentElement) {
      const blurring = BLURRING.filter((cls) => node!.classList.contains(cls));
      if (blurring.length) offenders.push(`${node.tagName.toLowerCase()}.${blurring.join(".")}`);
    }

    expect(offenders).toEqual([]);
  });

  it("covers the viewport rather than a slice of it", async () => {
    const drawer = await openDrawer();
    const overlay = drawer.parentElement;

    // `fixed inset-0` only means "the whole screen" while the containing block
    // IS the viewport, which is what the two tests above protect.
    expect(overlay?.className).toContain("fixed");
    expect(overlay?.className).toContain("inset-0");
  });

  it("paints above the header now that they are siblings", async () => {
    // Document order no longer settles it: the header is z-50, so the drawer
    // has to out-rank it explicitly.
    const drawer = await openDrawer();
    const overlay = drawer.parentElement!;
    const header = document.querySelector("header")!;

    const z = (el: Element) => Number(/z-\[?(\d+)\]?/.exec(el.className)?.[1] ?? 0);
    expect(z(overlay)).toBeGreaterThan(z(header));
  });

  it("still darkens the page behind it", async () => {
    /** The backdrop is what makes the menu readable over the constellation. */
    const drawer = await openDrawer();
    const backdrop = screen.getAllByRole("button", { name: /close menu/i })[0];

    expect(drawer.parentElement!.contains(backdrop)).toBe(true);
    expect(backdrop.className).toMatch(/bg-black\/\d+/);
  });
});
