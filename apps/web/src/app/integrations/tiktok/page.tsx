import type { Metadata } from "next";
import Link from "next/link";
import { GodeyeCrest } from "@/components/logo";
import { SITE_NAME } from "@/lib/site";

/**
 * What GODEYE does with a customer's TikTok account, in public.
 *
 * Written for two readers: a business deciding whether to connect an account,
 * and a TikTok reviewer checking that every requested scope is explained and
 * used. The review that prompted this page asked for exactly that, "all
 * selected products and scopes must be clearly demonstrated" and "a valid
 * official website that houses information about your services".
 */
export const metadata: Metadata = {
  title: "TikTok integration",
  description:
    "How GODEYE connects to TikTok: the permissions it asks for, what each one is used for, how videos are published, and how to disconnect.",
  alternates: { canonical: "/integrations/tiktok" },
  openGraph: {
    // Next replaces a page openGraph object wholesale; without this the tag
    // is absent on exactly the pages that get indexed.
    siteName: SITE_NAME,
    title: "GODEYE and TikTok",
    description:
      "The permissions GODEYE requests from TikTok, what each is used for, and how to disconnect.",
    url: "/integrations/tiktok",
  },
};

const SCOPES = [
  {
    scope: "user.info.basic",
    used: "To show you which account you connected",
    detail:
      "After you authorize, GODEYE reads your display name and avatar so the Connections page can show the account by name rather than an anonymous entry. It is also how GODEYE stops the same account being connected twice. Nothing else is read from your profile, and no follower or audience data is collected.",
  },
  {
    scope: "video.publish",
    used: "To post a finished video directly to your account",
    detail:
      "This is the main purpose of the integration. When a scheduled post comes due, GODEYE sends the video and its caption to TikTok and it appears on your account. Every post is one you created or approved in GODEYE beforehand. GODEYE never posts anything you have not scheduled.",
  },
  {
    scope: "video.upload",
    used: "To send a draft to your TikTok inbox instead",
    detail:
      "Some businesses would rather add the final touches in the TikTok app. That path sends the video to your inbox as a draft for you to finish and publish yourself. TikTok treats it as a separate permission from direct publishing, so both are requested, but only one is used per post, according to the setting you choose.",
  },
];

const STEPS = [
  {
    title: "You press Connect",
    body: "From the Connections page inside GODEYE. Nothing is asked of you beforehand, no developer account, no keys, no tokens to copy.",
  },
  {
    title: "TikTok asks you to authorize",
    body: "You sign in on TikTok's own screen and see exactly which permissions are being requested. GODEYE never sees your TikTok password.",
  },
  {
    title: "You create a post",
    body: "Write it yourself, or let GODEYE draft it from your brief. TikTok requires video, so still photographs are rendered into a video with your own licensed audio. You see the result before it goes anywhere.",
  },
  {
    title: "It publishes on schedule",
    body: "At the time you set, GODEYE sends the video to TikTok. The result comes back to your calendar as published, with a link to the live post, or as failed with the reason TikTok gave.",
  },
];

export default function TikTokIntegrationPage() {
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
          GODEYE and TikTok
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          GODEYE is a scheduling and publishing tool. It posts to a TikTok account on behalf of
          the business that owns it, at times that business chooses, using content that business
          created or approved. This page sets out precisely what it asks TikTok for and why.
        </p>
      </header>

      <section className="mt-14 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Permissions requested
        </h2>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
          Three, and no others. Each is used for the purpose described.
        </p>
        <div className="mt-7 space-y-7">
          {SCOPES.map((s) => (
            <article key={s.scope}>
              <h3 className="font-mono text-[14px] font-semibold">{s.scope}</h3>
              <p className="mt-1 text-[14px] font-medium">{s.used}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{s.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-14 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          How a post reaches TikTok
        </h2>
        <ol className="mt-7 space-y-6">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span className="font-mono text-[13px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3 className="text-[15px] font-semibold leading-snug">{step.title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-14 border-t border-line pt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Your data and your control
        </h2>
        <div className="mt-7 space-y-5 text-[14px] leading-relaxed text-ink-2">
          <p>
            <span className="font-medium text-ink-1">Disconnecting.</span> Press Disconnect on the
            Connections page at any time. GODEYE deletes the access token immediately and can no
            longer post. You can also revoke access from inside TikTok, under Security and
            permissions, and GODEYE will report the connection as expired rather than keep trying.
          </p>
          <p>
            <span className="font-medium text-ink-1">What is stored.</span> The access token, your
            TikTok account id and display name, and a record of the posts GODEYE sent, so your
            calendar can show what published and when. Access tokens are encrypted before they are
            written down.
          </p>
          <p>
            <span className="font-medium text-ink-1">What is not.</span> GODEYE does not read your
            videos, your followers, your messages or your analytics beyond the posts it sent
            itself. It does not post without a scheduled item you created or approved, and it never
            posts to an account that has not been connected by the person who controls it.
          </p>
          <p>
            Full detail is in the{" "}
            <Link href="/privacy" className="underline hover:text-ink-1">
              privacy policy
            </Link>{" "}
            and the{" "}
            <Link href="/terms" className="underline hover:text-ink-1">
              terms
            </Link>
            .
          </p>
        </div>
      </section>

      <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-8 text-[13px] text-ink-3">
        <span>© {new Date().getFullYear()} GODEYE</span>
        <Link href="/" className="hover:text-ink-2">
          Home
        </Link>
        <Link href="/pricing" className="hover:text-ink-2">
          Pricing
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
