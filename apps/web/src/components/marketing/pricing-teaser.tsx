import Link from "next/link";
import { PLANS, TRIAL_HOURS } from "@godeye/shared";
import { Reveal, Section } from "./section";

/**
 * The headline plan and a link to the real table.
 *
 * Figures come from the shared plan catalogue that also seeds the database, so
 * they are the ones the API enforces — the same source `/pricing` reads. A
 * teaser with its own hardcoded numbers is a teaser that quietly disagrees with
 * the page it links to.
 *
 * Deliberately not a second pricing table.
 */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function PricingTeaser() {
  const pro = PLANS.find((p) => p.code === "PRO") ?? PLANS[0];
  const others = PLANS.filter((p) => p.code !== pro.code);

  return (
    <Section
      id="pricing"
      eyebrow="Pricing"
      title={`Start with ${TRIAL_HOURS} hours. No card.`}
      lede="The trial is the full product publishing to your real accounts, not a preview. When it ends nothing is deleted — the workspace turns read-only until you pick a plan."
      className="border-t border-subtle"
    >
      <Reveal>
        <div className="hairline flex flex-col gap-8 rounded-2xl bg-raised p-6 sm:p-9 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-eyebrow uppercase text-muted">Most businesses start here</p>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="font-display text-display-lg font-semibold text-primary">
                {usd.format(pro.priceMonthlyUsd)}
              </span>
              <span className="text-[15px] text-muted">/ month · {pro.name}</span>
            </div>
            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-secondary">
              {pro.tagline}
            </p>
            <p className="mt-4 text-[13px] text-muted">
              Then {others.map((p) => `${p.name} ${usd.format(p.priceMonthlyUsd)}`).join(", ")}.
              Billed in US dollars. Cancel any time.
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-3 sm:flex-row lg:flex-col">
            <Link href="/register" className="btn-brand justify-center">
              Start free for {TRIAL_HOURS} hours
            </Link>
            <Link href="/pricing" className="btn-ghost justify-center">
              Compare all plans
            </Link>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
