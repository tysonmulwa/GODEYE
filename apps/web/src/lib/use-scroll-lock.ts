"use client";

import { useEffect } from "react";

/**
 * Freeze page scrolling while an overlay is open.
 *
 * The app shell lets the document scroll on phones (a fixed-height shell is
 * re-measured as the address bar collapses, which makes the page appear to
 * shake). The cost of that choice is that anything drawn over the page — a
 * drawer, a dialog, the command palette — would otherwise let the content slide
 * around underneath it, so every overlay has to hold the page still itself.
 *
 * Restores the previous value rather than clearing it, so nested overlays
 * unwind correctly instead of the inner one releasing the outer one's lock.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
