import Link from "next/link";
import { TRIAL_HOURS } from "@godeye/shared";
import { HeroVisual } from "./hero-visual";

/**
 * The hero.
 *
 * Server-rendered: the headline, the subcopy and both calls to action are in
 * the HTML a crawler receives. That is not incidental — the homepage used to be
 * a client component that rendered a spinner, which is why the site could not
 * rank for anything, and it is worth not undoing while making the page prettier.
 *
 * Only `HeroVisual` is a client component, because only it needs an observer.
 */

/** Positioned around the visual on desktop, a plain list under it on mobile. */
/**
 * Anchored to the same two gutters the flow lines occupy, at matching offsets,
 * so the four read as one frame around the composition rather than four labels
 * dropped at four unrelated percentages.
 */
const ANNOTATIONS = [
  { text: "One brief, every platform", at: "left-0 top-[14%] text-left" },
  { text: "Connected once", at: "left-0 bottom-[14%] text-left" },
  { text: "A week that fills itself", at: "right-0 top-[14%] text-right" },
  { text: "Findable, not just posted", at: "right-0 bottom-[14%] text-right" },
] as const;

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pb-[clamp(3rem,7vw,6rem)] pt-[clamp(3rem,7vw,5.5rem)]">
      <div className="mx-auto max-w-[1200px]">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-eyebrow uppercase text-muted">Marketing automation, run by agents</p>

          {/* One colour. A gradient across the words was tried and read as
              decoration applied to the sentence rather than as emphasis in it. */}
          <h1 className="mt-5 text-display-xl font-bold font-display text-primary">
            Marketing that runs without you in the room
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-body-lg text-secondary">
            GODEYE connects your channels, writes for each one, makes the images and the
            video, publishes on a schedule it works out from your own results, and keeps
            your site findable. You set the goal.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/register" className="btn-brand">
              Start free for {TRIAL_HOURS} hours
            </Link>
            <a href="#how-it-works" className="btn-ghost">
              See how it works
            </a>
          </div>

          <p className="mt-4 text-[13px] text-muted">
            No card. Publishes to real accounts, not a preview.
          </p>
        </div>

        {/* ---- The visual system ------------------------------------------ */}
        <div className="relative mt-[clamp(3rem,6vw,5rem)]">
          <HeroVisual />

          {/* Desktop: anchored around the composition. */}
          <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden>
            {ANNOTATIONS.map((a) => (
              <span
                key={a.text}
                className={`absolute ${a.at} w-[11rem] text-eyebrow uppercase leading-[1.5] text-muted`}
              >
                {a.text}
              </span>
            ))}
          </div>
        </div>

        {/* Mobile and tablet: the same four statements, stacked and readable.
            Shrinking the annotated composition to phone width turns it to mush,
            so it is not attempted. */}
        <ul className="mx-auto mt-10 grid max-w-md gap-3 sm:grid-cols-2 lg:hidden">
          {ANNOTATIONS.map((a) => (
            <li key={a.text} className="flex items-center gap-2.5">
              <span className="h-1 w-1 shrink-0 rounded-full bg-violet" aria-hidden />
              <span className="text-eyebrow uppercase text-muted">{a.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
