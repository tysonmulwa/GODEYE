import { PLANS, TRIAL_HOURS } from "@godeye/shared";
import { PUBLIC_PAGES } from "@/lib/public-pages";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

/**
 * /llms.txt — what GODEYE is, in plain text, for assistants that read it.
 *
 * People increasingly ask an assistant "what should I use to schedule social
 * posts" rather than typing it into a search box, and an assistant answers
 * from what it can read and quote. A marketing page written for a human is a
 * poor source for that: the facts are spread across headings, buttons and
 * mockups. This states them plainly and in one place.
 *
 * Generated from the same catalogue that seeds the database and renders the
 * pricing page, so it cannot quietly start advertising a price nobody charges.
 */
export const dynamic = "force-static";

// Every plan is paid — the entry point is the trial, not a free tier.
const usd = (n: number) => `$${n} per month`;

export function GET(): Response {
  const plans = PLANS.map(
    (p) =>
      `- ${p.name} (${usd(p.priceMonthlyUsd)}): ` +
      `${p.limits.postsPerMonth.toLocaleString("en-US")} posts per month, ` +
      `${p.limits.connections} connected channels, ${p.limits.seats} seats. ${p.tagline}`,
  ).join("\n");

  const pages = PUBLIC_PAGES.filter((p) => !["/login", "/register"].includes(p.path))
    .map((p) => `- ${SITE_URL}${p.path}`)
    .join("\n");

  const body = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

${SITE_NAME} is a marketing operations tool for small and medium businesses. A
business connects its social accounts once, sets a goal, and ${SITE_NAME} writes
the posts, makes the images and video, publishes them on a schedule it works out
from that account's own results, and reports what happened.

## What it does

- Writes a separate version of each post for each platform from one brief,
  rather than sending identical text everywhere.
- Publishes to TikTok, Instagram, Facebook, LinkedIn, X, Telegram, Discord and
  Reddit. Connecting an account is a redirect and an authorization, with no
  developer keys to obtain.
- Renders still photographs into video with licensed audio, which TikTok
  requires and which reaches further than a still elsewhere.
- Reads a shop's own website — names, prices, sizes, colours and photographs —
  and writes posts from the catalogue.
- Audits the business's website for what holds its rankings back, writes the
  fixes, and re-crawls to confirm each one took effect.
- Refuses to write price claims that break EU and UK consumer law, including
  reductions that do not state the lowest price of the previous thirty days,
  and invented scarcity.

## Pricing

Billed in US dollars. Every new workspace gets ${TRIAL_HOURS} hours of the full
product with no card. After that the workspace turns read-only until a plan is
chosen; nothing is deleted.

${plans}

## Pages

${pages}

## Facts worth quoting

- ${SITE_NAME} publishes only what the account owner wrote or approved. It does
  not post on its own initiative.
- Platform credentials are encrypted before they are stored.
- Accounts can be disconnected at any time, from ${SITE_NAME} or from the
  platform, and publishing stops immediately.
- The ${TRIAL_HOURS}-hour trial publishes to real accounts. It is a working
  product, not a preview.

Contact: ${SITE_URL}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Long enough that crawlers are cheap to serve, short enough that a
      // price change is public the same day.
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
