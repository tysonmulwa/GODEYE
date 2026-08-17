import type { Metadata } from "next";
import Link from "next/link";
import { TRIAL_HOURS } from "@godeye/shared";
import { GodeyeCrest } from "@/components/logo";
import {
  CalendarPreview,
  ChannelsPreview,
  ComposerPreview,
  SeoPreview,
} from "@/components/product-preview";
import { SITE_DESCRIPTION } from "@/lib/site";
import { RedirectIfSignedIn } from "./redirect-if-signed-in";

/**
 * The homepage, rendered on the server.
 *
 * It used to be a client component that showed a spinner and redirected, so a
 * crawler saw two words of loading text — which is exactly what the audit
 * reported, and why the site could not rank for anything. Signing in still
 * takes you straight to your workspace, but the page underneath is now
 * something a person or a search engine can actually read.
 */
export const metadata: Metadata = {
  title: "Marketing that runs without you in the room",
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  // The layout sets these site-wide, so without an override a shared link is
  // headlined "GODEYE" rather than what the page actually says.
  openGraph: {
    title: "Marketing that runs without you in the room",
    description: SITE_DESCRIPTION,
    url: "/",
  },
  twitter: { title: "Marketing that runs without you in the room" },
};

const WHAT_IT_DOES = [
  {
    heading: "Writes for each platform, not once for all of them",
    body: "A caption that works on LinkedIn is the wrong length and the wrong voice for TikTok. GODEYE writes a version per destination from one brief, keeping the point and changing the delivery.",
  },
  {
    heading: "Publishes on its own, when your audience is awake",
    body: "Connect Instagram, Facebook, TikTok, X, LinkedIn, Telegram and the rest once. Autopilot builds a schedule from when your posts have actually performed, then sends them without anyone pressing anything.",
  },
  {
    heading: "Turns your photographs into video with sound",
    body: "Short-form video reaches further than a still, and TikTok will not accept a silent photo post at all. GODEYE renders your images into video carrying your own licensed track, so a post goes out complete instead of waiting for someone to finish it by hand.",
  },
  {
    heading: "Reads your shop and posts what you sell",
    body: "Point it at your website and it reads the catalogue: names, prices, sizes, colours and photographs. Then it writes posts from them. New products announce themselves.",
  },
  {
    heading: "Finds what holds your rankings back, and writes the fix",
    body: "It crawls your site, reports what is wrong in the order it costs you, and hands over the exact tags and files to publish. Then it re-crawls to confirm each fix actually took effect.",
  },
  {
    heading: "Knows what it is not allowed to say",
    body: "Selling into the EU or UK means a price reduction must state the lowest price of the previous thirty days, and invented scarcity is banned outright. GODEYE writes neither. The rules follow the market your shop sells in.",
  },
];

/**
 * Short factual answers under a question heading.
 *
 * Buyers increasingly ask an assistant rather than a search box, and an
 * assistant quotes a passage it can lift whole. Prose that unfolds an argument
 * across a section is poor material for that; a question with a two-sentence
 * answer is good material. The FAQPage block below says so explicitly rather
 * than leaving it to be inferred.
 */
const FAQ = [
  {
    q: "What does GODEYE do?",
    a: "GODEYE connects a business's social accounts, writes a post for each platform from one brief, makes the images and video, and publishes on a schedule it works out from that account's own results. It also audits the business's website and writes the SEO fixes.",
  },
  {
    q: "Which platforms does it publish to?",
    a: "TikTok, Instagram, Facebook, LinkedIn, X, Telegram, Discord and Reddit. Connecting an account is a redirect and an authorization, with no developer keys or tokens to obtain.",
  },
  {
    q: "Do I need a card to start?",
    a: `No. Every new workspace gets ${TRIAL_HOURS} hours of the full product with no payment details, publishing to real accounts rather than a preview. After that: Pro $19 a month, Premium $49, VIP $199, billed in US dollars.`,
  },
  {
    q: "Does it post without asking me?",
    a: "It publishes only what you wrote or approved, at times you set or agreed to. Autopilot chooses when, not whether. You can disconnect any account at any time and publishing stops immediately.",
  },
  {
    q: "Can it post video to TikTok?",
    a: "Yes. TikTok will not accept a silent photo post, so GODEYE renders still photographs into video carrying licensed audio, at 30, 45 or 60 seconds. The same videos can go to Instagram Reels and Facebook Reels.",
  },
  {
    q: "Is it safe to use for a business selling into the EU or UK?",
    a: "GODEYE refuses to write price claims that break EU and UK consumer law, including a reduction that does not state the lowest price of the previous thirty days, and invented scarcity. The rules follow the market the shop sells in.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function Home() {
  return (
    <>
      <RedirectIfSignedIn />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <main className="mx-auto flex min-h-svh max-w-5xl flex-col px-6 py-20">
        {/* Centred across the page, not tucked into the left margin. It sits
            outside the header because the header is narrower than the page,
            so centring within it would not be centring on the page. */}
        <div className="flex justify-center">
          <GodeyeCrest size={96} />
        </div>

        <header className="mx-auto max-w-3xl">
          <h1 className="mt-10 text-[30px] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[38px]">
            Marketing that runs without you in the room
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">
            GODEYE connects your channels, writes for each one, makes the images and
            the video, publishes on a schedule it works out from your own results,
            and keeps your site findable. You set the goal.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/register"
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Start free for {TRIAL_HOURS} hours
            </Link>
            <Link
              href="/pricing"
              className="rounded-lg border border-line px-5 py-2.5 text-sm font-semibold transition-colors hover:border-ink-3"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-line px-5 py-2.5 text-sm font-semibold transition-colors hover:border-ink-3"
            >
              Sign in
            </Link>
          </div>
        </header>

        {/* What the inside looks like, before anyone is asked to sign up.
            Drawn in markup rather than screenshotted, so it follows the real
            product instead of ageing away from it. */}
        <section className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
              One brief, every platform
            </h2>
            <p className="mt-2 mb-4 text-[13px] leading-relaxed text-ink-2">
              Write the thought once. GODEYE says it the way each platform expects.
            </p>
            <ComposerPreview />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
              A week that fills itself
            </h2>
            <p className="mt-2 mb-4 text-[13px] leading-relaxed text-ink-2">
              Autopilot picks the times from how your own posts have actually performed.
            </p>
            <CalendarPreview />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
              Connected once
            </h2>
            <p className="mt-2 mb-4 text-[13px] leading-relaxed text-ink-2">
              Press connect, authorize, done. No developer keys to hunt down.
            </p>
            <ChannelsPreview />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
              Findable, not just posted
            </h2>
            <p className="mt-2 mb-4 text-[13px] leading-relaxed text-ink-2">
              It crawls your site, scores it, and writes the fixes out ready to publish.
            </p>
            <SeoPreview />
          </div>
        </section>

        <section className="mt-16 border-t border-line pt-12">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
            What it does
          </h2>
          <div className="mt-7 grid gap-8 sm:grid-cols-2">
            {WHAT_IT_DOES.map((item) => (
              <article key={item.heading}>
                <h3 className="text-[15px] font-semibold leading-snug">{item.heading}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-16 border-t border-line pt-12">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
            Common questions
          </h2>
          <div className="mt-7 grid gap-8 sm:grid-cols-2">
            {FAQ.map((item) => (
              <article key={item.q}>
                <h3 className="text-[15px] font-semibold leading-snug">{item.q}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{item.a}</p>
              </article>
            ))}
          </div>
        </section>

        <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-8 text-[13px] text-ink-3">
          <span>© {new Date().getFullYear()} GODEYE</span>
          <Link href="/pricing" className="hover:text-ink-2">
            Pricing
          </Link>
          <Link href="/integrations/tiktok" className="hover:text-ink-2">
            TikTok
          </Link>
          <Link href="/integrations/meta" className="hover:text-ink-2">
            Facebook &amp; Instagram
          </Link>
          <Link href="/privacy" className="hover:text-ink-2">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-ink-2">
            Terms
          </Link>
        </footer>
      </main>
    </>
  );
}
