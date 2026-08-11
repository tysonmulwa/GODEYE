import type { Metadata } from "next";
import Link from "next/link";
import { GodeyeCrest } from "@/components/logo";

/**
 * What GODEYE does with a Facebook Page and an Instagram Business account.
 *
 * Meta rejected four permissions under Developer Policy 1.6 — "your use case
 * for the requested permission is invalid or is not needed to support its core
 * functionality" — and asked, for each one, which functionality needs it, how
 * the integration works, and how it helps the end user. This page answers
 * those three questions per permission, in public, so a reviewer can read the
 * justification without taking anyone's word for it.
 */
export const metadata: Metadata = {
  title: "Facebook and Instagram integration",
  description:
    "How GODEYE publishes to a Facebook Page and an Instagram Business account: every permission it asks for, the feature that needs it, and how to disconnect.",
  alternates: { canonical: "/integrations/meta" },
  openGraph: {
    title: "GODEYE, Facebook and Instagram",
    description:
      "Every Meta permission GODEYE requests, the feature that needs it, and what it means for you.",
    url: "/integrations/meta",
  },
};

const PERMISSIONS = [
  {
    scope: "pages_show_list",
    feature: "Choosing which Page to publish to",
    how: "Many businesses administer more than one Page. After you sign in, GODEYE asks Meta for the list of Pages you manage and shows them so you can pick the one this workspace should post to. Without it there is no way to know which Page you mean, and no way to publish at all.",
    user: "You choose your Page from a list instead of hunting for a numeric Page ID in Meta's settings and pasting it in.",
  },
  {
    scope: "pages_manage_posts",
    feature: "Publishing the post",
    how: "When a scheduled post comes due, GODEYE sends the text, image or video to the Page you selected and it appears on your Page. Every post is one you wrote or approved in GODEYE first.",
    user: "Posts go out at the times you planned without anyone opening Facebook to press publish.",
  },
  {
    scope: "pages_read_engagement",
    feature: "Choosing when to post",
    how: "GODEYE reads how the Page's own published posts performed and uses that to work out which hours reach the most people. Autopilot then schedules into those hours instead of guessing. It reads engagement on posts only, and only for the Page you connected.",
    user: "The schedule is built from how this Page's audience actually behaves, rather than from generic advice about the best time to post.",
  },
  {
    scope: "instagram_business_basic",
    feature: "Naming the connected Instagram account",
    how: "After you authorize, GODEYE reads the account's username and profile picture so the Connections page shows which account is connected, and so the same account cannot be added twice by mistake.",
    user: "You can see at a glance which Instagram account a workspace posts to, which matters when an agency runs several.",
  },
  {
    scope: "instagram_business_content_publish",
    feature: "Publishing to Instagram",
    how: "Sends the finished image, carousel or Reel with its caption to the Instagram Business account you connected, at the scheduled time. Instagram requires media on every post, so photographs are prepared and Reels rendered before sending.",
    user: "Instagram is scheduled and published from the same place as everything else, instead of being the one channel that still has to be done by hand on a phone.",
  },
];

export default function MetaIntegrationPage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-3xl flex-col px-6 py-16">
      <header>
        <Link href="/" aria-label="GODEYE home" className="inline-block">
          <GodeyeCrest size={64} />
        </Link>
        <p className="mt-8 text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Integration
        </p>
        <h1 className="mt-3 text-[30px] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[38px]">
          GODEYE, Facebook and Instagram
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          GODEYE is a scheduling and publishing tool. A business connects its own Facebook Page
          and Instagram Business account, plans posts, and GODEYE publishes them at the times that
          business chose. It posts only what that business wrote or approved.
        </p>
      </header>

      <section className="mt-14 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Permissions, and the feature that needs each one
        </h2>
        <div className="mt-8 space-y-9">
          {PERMISSIONS.map((p) => (
            <article key={p.scope}>
              <h3 className="font-mono text-[14px] font-semibold">{p.scope}</h3>
              <p className="mt-1.5 text-[14px] font-medium">{p.feature}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{p.how}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                <span className="font-medium text-ink-1">For the person using it: </span>
                {p.user}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-14 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          What GODEYE does not do
        </h2>
        <ul className="mt-7 space-y-3 text-[14px] leading-relaxed text-ink-2">
          <li>
            It does not read your inbox, your comments, your followers or anyone&apos;s personal
            profile.
          </li>
          <li>
            It does not post without a scheduled item you created or approved, and it never posts
            to a Page or account that has not been connected by someone who administers it.
          </li>
          <li>
            It does not use Page or Instagram data to build advertising audiences, and it does not
            sell or share that data.
          </li>
          <li>
            It reads engagement figures only for posts on the Page you connected, and only to
            decide what time of day to schedule.
          </li>
        </ul>
      </section>

      <section className="mt-14 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Disconnecting
        </h2>
        <p className="mt-6 text-[14px] leading-relaxed text-ink-2">
          Press Disconnect on the Connections page and GODEYE deletes the access token
          immediately. You can also remove GODEYE from Business Integrations in your Facebook
          settings, and GODEYE will report the connection as expired rather than keep trying.
          Access tokens are encrypted before they are stored. The{" "}
          <Link href="/privacy" className="underline hover:text-ink-1">
            privacy policy
          </Link>{" "}
          sets out what is kept and for how long.
        </p>
      </section>

      <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-8 text-[13px] text-ink-3">
        <span>© {new Date().getFullYear()} GODEYE</span>
        <Link href="/" className="hover:text-ink-2">
          Home
        </Link>
        <Link href="/pricing" className="hover:text-ink-2">
          Pricing
        </Link>
        <Link href="/integrations/tiktok" className="hover:text-ink-2">
          TikTok
        </Link>
        <Link href="/privacy" className="hover:text-ink-2">
          Privacy
        </Link>
      </footer>
    </main>
  );
}
