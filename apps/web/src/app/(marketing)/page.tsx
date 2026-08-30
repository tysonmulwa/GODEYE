import type { Metadata } from "next";
import { TRIAL_HOURS } from "@godeye/shared";
import { ClosingCta } from "@/components/marketing/closing-cta";
import { ConnectOnce } from "@/components/marketing/connect-once";
import { Faq } from "@/components/marketing/faq";
import { FeatureBento } from "@/components/marketing/feature-bento";
import { Findable } from "@/components/marketing/findable";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { PricingTeaser } from "@/components/marketing/pricing-teaser";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { websiteJsonLd } from "@/lib/structured-data";
import { RedirectIfSignedIn } from "./redirect-if-signed-in";

/**
 * The homepage, rendered on the server.
 *
 * It used to be a client component that showed a spinner and redirected, so a
 * crawler saw two words of loading text, which is exactly what the audit
 * reported, and why the site could not rank for anything. Signing in still
 * takes you straight to your workspace, but the page underneath is now
 * something a person or a search engine can actually read.
 *
 * The redesign kept that property: everything below is server-rendered except
 * the four components that genuinely need an observer or a scroll listener.
 */
export const metadata: Metadata = {
  /**
   * Brand first, and `absolute` so the layout's `%s · GODEYE` template does not
   * append a second one.
   *
   * The homepage title is one of the handful of signals Google reads when it
   * decides what to print above a result. It previously read "Marketing that
   * runs without you in the room · GODEYE": the name was present but last,
   * behind nine words of positioning, while the domain spells out a longer
   * name. Leading with it removes that competition.
   *
   * This is the only page whose title is brand-first. Every other page keeps
   * `%s · GODEYE`, because "Pricing · GODEYE" is the right shape for a result
   * and only the homepage feeds the site-name signal.
   */
  title: { absolute: `${SITE_NAME} · AI marketing automation` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  // The layout sets these site-wide, so without an override a shared link is
  // headlined "GODEYE" rather than what the page actually says.
  openGraph: {
    // siteName is repeated here on purpose. Next REPLACES a page's openGraph
    // object wholesale rather than merging it into the layout's, so overriding
    // the title to get a decent share card silently dropped og:site_name from
    // the four public pages -- the only ones a search engine indexes. Verified
    // in the build output: every app page had the tag and none of the marketing
    // pages did.
    siteName: SITE_NAME,
    // Matches the <title> rather than restating the headline. og:title is read
    // alongside it for the same decision, and two different answers is a
    // weaker signal than one answer twice.
    title: `${SITE_NAME} · AI marketing automation`,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  twitter: { title: `${SITE_NAME} · AI marketing automation` },
};

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
    q: "Which platforms does it publish to?",
    a: "TikTok, Instagram, Facebook, LinkedIn, X, Telegram, Discord and Reddit. Connecting an account is a redirect and an authorization, with no developer keys or tokens to obtain.",
  },
  {
    q: "Can I approve posts before they go out?",
    a: "Yes. GODEYE publishes only what you wrote or approved, at times you set or agreed to. Autopilot chooses when, not whether, and you can edit any generated version before it is scheduled.",
  },
  {
    q: "What happens to my accounts?",
    a: "Nothing you did not ask for. GODEYE posts only the scheduled items you created or approved, and never to an account that was not connected by the person who controls it. Press Disconnect at any time and the access token is deleted immediately; revoking access from inside the platform works too, and GODEYE reports the connection as expired rather than retrying.",
  },
  {
    q: "What data does it use?",
    a: "The access token, your account id and display name, and a record of the posts GODEYE sent so your calendar can show what published and when. Tokens are encrypted before they are stored. It does not read your videos, your followers, your messages, or any analytics beyond the posts it sent itself.",
  },
  {
    q: "Do I need a card to start?",
    a: `No. Every new workspace gets ${TRIAL_HOURS} hours of the full product with no payment details, publishing to real accounts rather than a preview. After that: Pro $19 a month, Premium $49, VIP $199, billed in US dollars.`,
  },
  {
    q: "How do I cancel?",
    a: "Any time, from the billing page. You keep the paid plan until the end of the period you have already paid for, and your posts, connections and history stay. Nothing is deleted when a plan ends. The workspace turns read-only until you pick another.",
  },
  {
    q: "Can it post video to TikTok?",
    a: "Yes. TikTok will not accept a silent photo post, so GODEYE renders still photographs into video carrying licensed audio, at 30, 45 or 60 seconds. The same videos can go to Instagram Reels and Facebook Reels.",
  },
  {
    q: "Is it safe to use for a business selling into the EU or UK?",
    a: "GODEYE refuses to write price claims that break EU and UK consumer law, including a reduction that does not state the lowest price of the previous thirty days, and invented scarcity. The rules follow the market the shop sells in.",
  },
] as const;

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
      {/* The homepage, and only the homepage: this is where Google reads the
          site's name from, and a second WebSite entity elsewhere makes the
          signal ambiguous rather than stronger. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <Hero />
      <ConnectOnce />
      <HowItWorks />
      <FeatureBento />
      <Findable />
      <PricingTeaser />
      <Faq items={FAQ} />
      <ClosingCta />
    </>
  );
}
