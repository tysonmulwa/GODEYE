"use client";

import { GodeyeEmblem } from "@/components/logo";
import { PLATFORM_GLYPHS, PLATFORM_MARKS } from "@/components/platform-marks";
import { useInView } from "@/lib/use-in-view";

/**
 * The hero composition: one brief at the centre, every channel around it, a
 * week of scheduled posts coming out the other side.
 *
 * ## Why none of this is an image
 *
 * The brief specified the centre hub as an exported raster (AVIF with a WebP
 * fallback, under ~180KB). It is coded instead, for reasons that all point the
 * same way:
 *
 *   - `next/image` is used **nowhere** in this app. Shipping the hero as the
 *     first image ever served through that pipeline, on Cloudflare Workers,
 *     makes the most important element on the site the least proven one.
 *   - The route budget is ~90KB. A 180KB hero does not fit inside it — the two
 *     numbers in the brief are not compatible, and the image is the half that
 *     had a cheaper alternative.
 *   - This is ~4KB of markup, sharp at every DPI, with no CLS because it has
 *     intrinsic dimensions and nothing to load.
 *   - It is built from the same tokens as the product, so it cannot drift out
 *     of date the way `product-preview.tsx` already explains at length.
 *
 * ## Mobile
 *
 * The flow lines and the calendar cluster are desktop-only. They are hidden
 * with CSS rather than removed by a JS media query: a `matchMedia` check would
 * have to run after hydration, which means either a server/client mismatch or
 * the composition visibly reflowing on load. `display: none` also stops the
 * animations — a hidden element is not animated — so the runtime cost on a
 * phone is genuinely nil, and the markup cost is about 1KB of static SVG.
 */

/**
 * Where the ring's edge sits, in pixels from the centre.
 *
 * The orbit box is 440px at its widest and the ring is 84% of it, so the edge
 * is at 0.42 x 440 = 185px. The flow lines stop 14px beyond that, which is far
 * enough to read as "outside" without leaving a visible gap.
 *
 * Declared once because it is the one number the CSS ring and the SVG gutters
 * both depend on; when they disagreed, the lines ran into the circle.
 */
const RING_RADIUS = 185;
const RING_EDGE = RING_RADIUS + 14;

/**
 * Eight channels, evenly spaced, deliberately offset by 22.5° so that no icon
 * sits at 0° or 180° where the flow lines leave the hub.
 */
const ORBIT = [
  "TIKTOK",
  "INSTAGRAM",
  "FACEBOOK",
  "LINKEDIN",
  "X",
  "REDDIT",
  "TELEGRAM",
  "DISCORD",
] as const;

const LABELS: Record<(typeof ORBIT)[number], string> = {
  TIKTOK: "TikTok",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  LINKEDIN: "LinkedIn",
  X: "X",
  REDDIT: "Reddit",
  TELEGRAM: "Telegram",
  DISCORD: "Discord",
};

/** Illustrative product UI, not a claim about any real account. */
const WEEK = [
  { day: "Mon", state: "published" },
  { day: "Tue", state: "published" },
  { day: "Wed", state: "scheduled" },
  { day: "Thu", state: "scheduled" },
  { day: "Fri", state: "scheduled" },
] as const;

const STATE_STYLE = {
  published: "text-published",
  scheduled: "text-scheduled",
} as const;

function OrbitIcon({ platform, index }: { platform: (typeof ORBIT)[number]; index: number }) {
  const angle = (-67.5 + index * 45) * (Math.PI / 180);
  const radius = 42; // % of the orbit box
  const left = 50 + Math.cos(angle) * radius;
  const top = 50 + Math.sin(angle) * radius;
  const brand = PLATFORM_GLYPHS[platform]?.bg ?? "#7C6BF7";

  return (
    <div
      className="group absolute"
      style={{ left: `${left}%`, top: `${top}%`, transform: "translate(-50%, -50%)" }}
    >
      {/* Counter-spin, so a logo carried around the ring never tips over. Same
          duration as .orbit-ring or the two drift apart. */}
      <div className="orbit-upright">
        <div
          // A small independent float on top of the orbit: staggered delays and
          // slightly different periods, so the ring breathes rather than
          // travelling as one rigid object.
          className="orbit-float"
          style={
            {
              "--float-delay": `${(index * 0.7).toFixed(2)}s`,
              "--float-dur": `${6 + (index % 4)}s`,
            } as React.CSSProperties
          }
        >
        <span
          className="m-glass flex h-11 w-11 items-center justify-center rounded-xl text-primary transition-all duration-[--dur-mid] group-hover:scale-110 sm:h-12 sm:w-12"
          style={{ ["--brand" as string]: brand }}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
            {PLATFORM_MARKS[platform]}
          </svg>
        </span>
        </div>
      </div>
      {/* Tooltip. Mouse affordance only — every channel is named in the
          composition's description for anyone not using a pointer. */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] text-secondary opacity-0 transition-opacity duration-[--dur-fast] group-hover:opacity-100"
      >
        {LABELS[platform]}
      </span>
    </div>
  );
}

export function HeroVisual() {
  const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.2 });

  return (
    <div
      ref={ref}
      className="relative mx-auto w-full max-w-[1160px]"
      // One descriptive alternative for the whole composition; every moving
      // part inside it is decorative and hidden from assistive tech.
      role="img"
      aria-label={
        "One brief at the centre of GODEYE, connected outward to TikTok, Instagram, " +
        "Facebook, LinkedIn, X, Reddit, Telegram and Discord, and forward into a week " +
        "of posts already published and scheduled."
      }
    >
      {/*
        ---- Flow lines, desktop only -------------------------------------

        Two SVGs, one per gutter, each stopping clear of the ring — rather than
        one SVG across the whole composition.

        The single-SVG version could not be made to line up. Its coordinates
        were fixed in a 1160-unit viewBox scaled with `meet`, while the ring's
        size comes from CSS (84% of a max-440px square). Those two systems
        disagree at every viewport width, which is why a line that was supposed
        to stop at the edge ended up terminating *inside* the circle, and why
        the travelling dash appeared to break there.

        Anchoring each gutter to `calc(50% ± RING_EDGE)` makes it exact at any
        width: the line physically cannot enter the circle, because the element
        drawing it stops before the circle begins.

        `preserveAspectRatio="none"` is safe here because each SVG's pixel
        height equals its viewBox height, so the vertical scale is exactly 1 and
        stroke weight is unaffected. Only the horizontal axis stretches, and
        these are near-horizontal lines.
      */}
      <svg
        className="pointer-events-none absolute left-0 top-1/2 hidden h-[100px] -translate-y-1/2 md:block"
        // An explicit width, not a `right` anchor. <svg> is a replaced element:
        // with width:auto it takes its INTRINSIC size from the viewBox (300px)
        // and ignores `right` entirely, so the gutter never reached the ring and
        // the line stopped wherever 300px happened to land.
        style={{ width: `calc(50% - ${RING_EDGE}px)` }}
        viewBox="0 0 300 100"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden
      >
        <defs>
          {/* Fades in from the edge of the frame rather than starting in mid
              air, which read as a line coming from nothing. */}
          <linearGradient id="flow-in" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent-violet)" stopOpacity="0.05" />
            <stop offset="40%" stopColor="var(--accent-violet)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--accent-violet)" stopOpacity="0.95" />
          </linearGradient>
        </defs>
        <path d="M0 50 H300" stroke="url(#flow-in)" strokeWidth="1.5" />
        <path
          d="M0 50 H300"
          stroke="var(--accent-violet)"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="flow-dash"
        />
      </svg>

      <svg
        className="pointer-events-none absolute right-0 top-1/2 hidden h-[220px] -translate-y-1/2 md:block"
        style={{ width: `calc(50% - ${RING_EDGE}px)` }}
        viewBox="0 0 300 220"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden
      >
        <defs>
          <linearGradient id="flow-out" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent-violet)" stopOpacity="0.95" />
            <stop offset="60%" stopColor="var(--accent-cyan)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.2" />
          </linearGradient>
        </defs>
        {/* Leaves the ring together, then fans to the two ends of the week. */}
        <path d="M0 110 C 110 110, 150 40, 300 40" stroke="url(#flow-out)" strokeWidth="1.5" />
        <path d="M0 110 C 110 110, 150 180, 300 180" stroke="url(#flow-out)" strokeWidth="1.5" />
        <path
          d="M0 110 C 110 110, 150 40, 300 40"
          stroke="var(--accent-cyan)"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="flow-dash"
          style={{ ["--float-delay" as string]: "1.2s" }}
        />
        <path
          d="M0 110 C 110 110, 150 180, 300 180"
          stroke="var(--accent-cyan)"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="flow-dash"
          style={{ ["--float-delay" as string]: "2.6s" }}
        />
      </svg>

      {/* ---- Hub and orbit ------------------------------------------------ */}
      <div className="relative mx-auto aspect-square w-full max-w-[380px] sm:max-w-[440px]">
        {/* The one glow that marks the live centre of the system. */}
        <div
          aria-hidden
          className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70 blur-3xl"
          style={{ background: "radial-gradient(circle, #7C6BF7 0%, transparent 70%)" }}
        />
        {/* Orbit ring. */}
        <div
          aria-hidden
          className="absolute left-1/2 top-1/2 h-[84%] w-[84%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-subtle"
        />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {/* Neutral like the rest of the crest marks. The violet glow behind it
            still makes this read as the lit centre of the system, without the
            logo itself carrying a colour it does not carry anywhere else. */}
        <GodeyeEmblem className="h-24 w-24 text-primary sm:h-28 sm:w-28" />
        </div>
        {/* The ring itself turns. Icons are positioned inside it, so rotating
            this one element carries all eight around the circle. */}
        <div className="orbit-ring absolute inset-0">
          {ORBIT.map((platform, i) => (
            <OrbitIcon key={platform} platform={platform} index={i} />
          ))}
        </div>
      </div>

      {/* ---- Calendar cluster, desktop only -------------------------------
          Staggered in on scroll, once. Uses the status tokens, never the
          brand accents. */}
      <div
        className="pointer-events-none absolute right-0 top-1/2 hidden -translate-y-1/2 flex-col gap-2 md:flex"
        aria-hidden
      >
        {WEEK.map((slot, i) => (
          <div
            key={slot.day}
            data-shown={shown}
            className="reveal m-glass flex items-center gap-2.5 rounded-lg px-3 py-2"
            style={{ transitionDelay: `${200 + i * 90}ms` }}
          >
            <span className="w-8 text-[11px] text-muted">{slot.day}</span>
            <span className={`text-[11px] ${STATE_STYLE[slot.state]}`}>●</span>
            <span className="text-[11px] text-secondary">{slot.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
