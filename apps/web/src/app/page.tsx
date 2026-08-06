import type { Metadata } from "next";
import Link from "next/link";
import { GodeyeCrest } from "@/components/logo";
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

export default function Home() {
  return (
    <>
      <RedirectIfSignedIn />
      <main className="mx-auto flex min-h-svh max-w-3xl flex-col justify-center px-6 py-20">
        <header>
          <GodeyeCrest size={96} />
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
              Start free
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

        <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-8 text-[13px] text-ink-3">
          <span>© {new Date().getFullYear()} GODEYE</span>
          <Link href="/pricing" className="hover:text-ink-2">
            Pricing
          </Link>
          <Link href="/integrations/tiktok" className="hover:text-ink-2">
            TikTok integration
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
