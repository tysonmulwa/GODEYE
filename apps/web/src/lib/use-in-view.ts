"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fires once, the first time an element scrolls into view.
 *
 * This is what stands in for an animation library on the marketing pages.
 * `framer-motion` is already a dependency of the dashboard, so reaching for it
 * here would have cost nothing to install and roughly 30KB to ship — on a route
 * with a 90KB budget, deployed to a paid edge runtime, for the sole purpose of
 * fading a heading in.
 *
 * Two properties matter more than the size:
 *
 *   1. **It fires once and disconnects.** An observer left attached re-triggers
 *      every time the user scrolls back up, which turns a considered entrance
 *      into a page that keeps flickering at anyone reading it twice.
 *
 *   2. **Under `prefers-reduced-motion: reduce` it never observes at all** — it
 *      returns `true` on the first render, so the element is in its final state
 *      from the start. The alternative, observing and then animating instantly,
 *      still leaves the content at `opacity: 0` until a scroll event arrives,
 *      which for a reader who has asked for less motion is a blank page.
 *
 * The media query is read inside the effect rather than at module scope: it is
 * a browser API, this file is imported by a server-rendered tree, and the
 * server has no opinion about anyone's motion preference.
 */
export function useInView<T extends HTMLElement>(options?: {
  /** How much of the element must be visible. Default 0.15. */
  threshold?: number;
  /** Start the animation slightly before the element reaches the fold. */
  rootMargin?: string;
}) {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Asked for less motion: show it, observe nothing.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }

    // An element already on screen at first paint — the hero — would otherwise
    // wait for a scroll event that may never come.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setShown(true);
          observer.disconnect();
        }
      },
      {
        threshold: options?.threshold ?? 0.15,
        rootMargin: options?.rootMargin ?? "0px 0px -10% 0px",
      },
    );

    observer.observe(node);
    return () => observer.disconnect();
    // The two primitives rather than `options`: a caller passing an object
    // literal creates a new identity on every render, which would tear down and
    // re-create the observer on each one.
  }, [options?.threshold, options?.rootMargin]);

  return { ref, shown } as const;
}
