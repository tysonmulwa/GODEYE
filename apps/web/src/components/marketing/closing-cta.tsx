import Link from "next/link";
import { TRIAL_HOURS } from "@godeye/shared";

/**
 * The closing panel.
 *
 * The gradient is on the panel's EDGE, not its fill: a 1px gradient border with
 * the near-black surface inset inside it. A full-bleed gradient fill would put
 * body text on a mid-tone violet-to-cyan wash, where nothing clears 4.5:1 in
 * either direction.
 */
export function ClosingCta() {
  return (
    <section className="px-6 pb-[clamp(4rem,8vw,7rem)] pt-[clamp(3rem,6vw,5rem)]">
      <div className="mx-auto max-w-[1200px]">
        <div
          className="rounded-3xl p-px"
          style={{ background: "var(--brand-gradient)" }}
        >
          <div className="relative overflow-hidden rounded-[calc(1.5rem-1px)] bg-base px-6 py-14 text-center sm:px-12 sm:py-20">
            {/* A single wash so the panel is not a flat black rectangle. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-50"
              style={{
                background:
                  "radial-gradient(50% 100% at 50% 0%, rgb(124 107 247 / 0.35), transparent 70%)",
              }}
            />
            <div className="relative">
              <h2 className="mx-auto max-w-2xl text-display-lg font-display font-semibold text-primary">
                Set the goal. Let it run.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-body-lg text-secondary">
                Connect a channel and watch a week fill itself. {TRIAL_HOURS} hours, the whole
                product, no card.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link href="/register" className="btn-brand">
                  Start free for {TRIAL_HOURS} hours
                </Link>
                <Link href="/pricing" className="btn-ghost">
                  See pricing
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
