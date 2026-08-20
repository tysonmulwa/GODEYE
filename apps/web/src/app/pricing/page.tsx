import type { Metadata } from "next";
import Link from "next/link";
import { PLANS, PLAN_FEATURES, TRIAL_HOURS } from "@godeye/shared";
import { GodeyeCrest } from "@/components/logo";
import { SITE_NAME } from "@/lib/site";

/**
 * The public pricing page, rendered on the server.
 *
 * Plans come from the shared catalogue that also seeds the database, so the
 * figures here are the ones the API enforces. A pricing page maintained by
 * hand drifts, and the customer finds out after paying.
 */
export const metadata: Metadata = {
  title: "Pricing",
  description:
    `GODEYE pricing in USD. Every workspace starts with ${TRIAL_HOURS} hours of full access, ` +
    "no card needed. Pro $19 a month, Premium $49, VIP $199.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    // Next replaces a page openGraph object wholesale; without this the tag
    // is absent on exactly the pages that get indexed.
    siteName: SITE_NAME,
    title: "GODEYE pricing",
    description: `${TRIAL_HOURS} hours free, no card. Then Pro $19 a month, Premium $49, VIP $199.`,
    url: "/pricing",
  },
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

function value(key: string, n: number): string {
  return key === "aiTokensPerMonth" ? compact.format(n) : n.toLocaleString("en-US");
}

const QUESTIONS = [
  {
    q: "What can I pay with?",
    a: `Card, Apple Pay or M-Pesa, all through Paystack. A card subscription is billed in US dollars and renews itself every month. Apple Pay and M-Pesa cannot be charged again automatically, so those buy one month at a time, priced in shillings: ${PLANS.map((p) => `${p.name} ${p.priceMonthlyKes.toLocaleString("en-US")}`).join(", ")} KES. When a bought month ends the workspace turns read-only until you buy the next one, and nothing is deleted.`,
  },
  {
    q: "Do I need a card to start?",
    a: `No. Every new workspace gets ${TRIAL_HOURS} hours of the full product with no payment details at all, and it publishes real posts to real accounts rather than being a preview.`,
  },
  {
    q: `What happens after the ${TRIAL_HOURS} hours?`,
    a: "The workspace turns read-only until you choose a plan. Nothing is deleted: your posts, drafts, connected channels and history are all still there, and picking a plan switches everything back on straight away.",
  },
  {
    q: "What happens when I reach a limit?",
    a: "GODEYE stops rather than charging you for the overage. Nothing publishes past your plan, and the billing page shows how close you are before you get there.",
  },
  {
    q: "Can I cancel?",
    a: "Any time, from the billing page. You keep the paid plan until the end of the period you have already paid for. Your posts, connections and history stay.",
  },
];

/**
 * The questions again, as structured data.
 *
 * Answer engines quote a short factual passage under a question heading, and
 * FAQPage is how a page says "these are questions and these are the answers"
 * rather than leaving it to be inferred from markup. Generated from the same
 * array the page renders, so the two cannot disagree.
 */
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: QUESTIONS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function PricingPage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-5xl flex-col px-6 py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <header className="mx-auto max-w-2xl text-center">
        <Link href="/" aria-label="GODEYE home" className="inline-block">
          <GodeyeCrest size={64} />
        </Link>
        <h1 className="mt-8 text-[30px] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[38px]">
          Priced for what you publish
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          Every plan writes, generates the images and video, publishes on its own schedule and
          watches your rankings. The difference is volume, not features. Billed in US dollars.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Every new workspace starts with{" "}
          <span className="font-semibold text-ink">{TRIAL_HOURS} hours of full access</span>, no
          card, no preview mode, real posts on your real accounts.
        </p>
      </header>

      <section className="mt-14 grid gap-5 lg:grid-cols-3">
        {PLANS.map((p) => {
          const featured = p.code === "PRO";
          return (
            <article
              key={p.code}
              className={`rounded-2xl border p-6 ${
                featured ? "border-accent shadow-sm" : "border-line"
              }`}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-3">
                  {p.name}
                </h2>
                {featured && (
                  <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-white">
                    Most chosen
                  </span>
                )}
              </div>
              <p className="mt-4">
                <span className="font-mono text-[34px] font-bold leading-none">
                  {usd.format(p.priceMonthlyUsd)}
                </span>
                <span className="text-sm text-ink-3">/month</span>
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">{p.tagline}</p>
              <ul className="mt-6 space-y-2.5 text-sm">
                {PLAN_FEATURES.map((f) => (
                  <li key={f.key} className="flex gap-2">
                    <span aria-hidden className="text-accent">
                      &#10003;
                    </span>
                    <span>
                      <span className="font-mono">{value(f.key, p.limits[f.key])}</span>{" "}
                      <span className="text-ink-2">{f.label}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                href="/register"
                className={`mt-7 block rounded-lg px-5 py-2.5 text-center text-sm font-semibold transition-colors ${
                  featured
                    ? "bg-accent text-white hover:bg-accent-hover"
                    : "border border-line hover:border-ink-3"
                }`}
              >
                Start with {p.name}
              </Link>
            </article>
          );
        })}
      </section>

      <section className="mt-16 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Questions
        </h2>
        <div className="mt-7 grid gap-8 sm:grid-cols-2">
          {QUESTIONS.map((item) => (
            <article key={item.q}>
              <h3 className="text-[15px] font-semibold leading-snug">{item.q}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{item.a}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-8 text-[13px] text-ink-3">
        <span>© {new Date().getFullYear()} GODEYE</span>
        <Link href="/" className="hover:text-ink-2">
          Home
        </Link>
        <Link href="/privacy" className="hover:text-ink-2">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-ink-2">
          Terms
        </Link>
      </footer>
    </main>
  );
}
