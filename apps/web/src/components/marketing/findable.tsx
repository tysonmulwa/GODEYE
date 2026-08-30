"use client";

import { useEffect, useState } from "react";
import { useInView } from "@/lib/use-in-view";
import { Section } from "./section";

/**
 * The SEO/AEO panel: a score, and the fixes written out ready to publish.
 *
 * The 91 is illustrative product UI — a score GODEYE would show for a site it
 * had crawled — not a claim about anything. Same footing as the calendar chips,
 * and the same footing `product-preview.tsx` already states for its own.
 */

const SCORE = 91;
const RADIUS = 46;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const ACTIONS = [
  { label: "Expand this page", detail: "Thin content, 180 words", tone: "scheduled" },
  { label: "Publish sitemap.xml", detail: "4 pages currently unlisted", tone: "scheduled" },
  { label: "Publish the IndexNow key", detail: "Faster recrawl on change", tone: "cyan" },
  { label: "Add FAQ structured data", detail: "Eligible for rich results", tone: "cyan" },
] as const;

const TONE = {
  scheduled: "bg-scheduled",
  cyan: "bg-cyan",
} as const;

/**
 * Counts up once, on scroll-in.
 *
 * Driven by rAF rather than a CSS transition because the *number* has to
 * change, not just the arc. Under reduced motion `useInView` returns shown on
 * the first render and the effect writes the final value immediately — the
 * dial is simply correct rather than animated, which is what "a complete
 * static composition" means for this element.
 */
function useCountUp(target: number, shown: boolean): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!shown) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const duration = 1100;

    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // Same easing curve as every other transition on the page.
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shown, target]);

  return value;
}

export function Findable() {
  const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.35 });
  const score = useCountUp(SCORE, shown);

  return (
    <Section
      id="findable"
      eyebrow="Findable, not just posted"
      title="Posting is half of it. Being found is the other half."
      lede="GODEYE crawls your site, scores it, and writes the fixes out ready to publish, then re-crawls to confirm each one actually took effect."
      className="border-t border-subtle"
    >
      <div ref={ref} className="m-glass grid gap-8 rounded-2xl p-6 sm:p-9 lg:grid-cols-[auto_1fr] lg:gap-14">
        {/* ---- The dial ---- */}
        <div className="flex items-center gap-6 lg:flex-col lg:items-start lg:gap-4">
          <div className="relative shrink-0">
            <svg width="128" height="128" viewBox="0 0 112 112" aria-hidden>
              <circle
                cx="56"
                cy="56"
                r={RADIUS}
                fill="none"
                strokeWidth="8"
                stroke="var(--border-subtle)"
              />
              <circle
                cx="56"
                cy="56"
                r={RADIUS}
                fill="none"
                strokeWidth="8"
                strokeLinecap="round"
                stroke="var(--status-published)"
                strokeDasharray={`${(score / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                transform="rotate(-90 56 56)"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {/* tabular-nums so the number does not jitter as it counts. */}
              <span className="tnum font-display text-[30px] font-semibold leading-none text-primary">
                {score}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted">
                Score
              </span>
            </div>
          </div>
          <div>
            <p className="text-[13px] text-secondary">godeyeautomation.com</p>
            <p className="mt-1 text-[12px] text-muted">Crawled 4 minutes ago · 38 pages</p>
          </div>
        </div>

        {/* ---- The proposed actions ---- */}
        <div>
          <p className="text-eyebrow uppercase text-muted">Proposed actions</p>
          <ul className="mt-4 space-y-2">
            {ACTIONS.map((a, i) => (
              <li
                key={a.label}
                data-shown={shown}
                className="reveal flex items-center gap-3 rounded-xl border border-subtle bg-elevated px-4 py-3"
                style={{ transitionDelay: `${300 + i * 100}ms` }}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[a.tone]}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-primary">{a.label}</span>
                  <span className="block truncate text-[12px] text-muted">{a.detail}</span>
                </span>
                <span className="shrink-0 rounded-md border border-subtle px-2 py-1 text-[10px] uppercase tracking-wider text-muted">
                  Proposed
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-muted">
            Each one comes with the exact tags or file to publish. Nothing is changed on your
            site without you.
          </p>
        </div>
      </div>
    </Section>
  );
}
