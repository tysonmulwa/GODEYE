"use client";

import { useEffect, useState } from "react";

/**
 * Announces an async status change to a screen reader.
 *
 * WCAG 2.2 AA: 4.1.3 Status Messages.
 *
 * Every long-running thing in this product is polled — image generation, video
 * rendering, SEO crawls — and the UI communicates progress purely visually: a
 * spinner appears, text changes, the spinner goes. A screen-reader user gets
 * **nothing**. They press Generate, hear nothing for ninety seconds, and have no
 * way to tell a slow render from a failure.
 *
 * `aria-live="polite"` is the whole fix, but two details decide whether it
 * actually works:
 *
 * 1. **The region must exist before the message does.** A live region added to
 *    the DOM at the same time as its content is frequently not announced at all
 *    — the assistive tech never saw an empty region to start watching. So this
 *    always renders, and only the text inside it changes.
 *
 * 2. **Polite, not assertive.** `assertive` interrupts whatever is being read,
 *    which for a progress update is rude and, at one update per poll, unusable.
 *    `assertive` is for errors that stop the task.
 */
export function LiveStatus({
  message,
  urgent = false,
}: {
  /** Null or empty announces nothing. */
  message: string | null;
  /** Use for a failure the person must act on, not for progress. */
  urgent?: boolean;
}) {
  // Debounced. A poll every two seconds that re-announces "Generating…"
  // unchanged is a screen reader talking over itself, so only real changes are
  // pushed into the region.
  const [announced, setAnnounced] = useState("");

  useEffect(() => {
    const next = message ?? "";
    if (next === announced) return;
    const timer = setTimeout(() => setAnnounced(next), 150);
    return () => clearTimeout(timer);
  }, [message, announced]);

  return (
    <div
      // sr-only, not hidden: `display: none` removes it from the accessibility
      // tree and nothing is ever announced.
      className="sr-only"
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {announced}
    </div>
  );
}
