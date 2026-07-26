import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — GODEYE",
  description: "The terms you agree to when using GODEYE.",
};

const UPDATED = "26 July 2026";

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="lead">Last updated: {UPDATED}</p>

      <p>
        These terms cover your use of GODEYE. By creating an account you agree to them. If you
        don&rsquo;t, please don&rsquo;t use the service.
      </p>

      <h2>What GODEYE does</h2>
      <p>
        GODEYE helps you plan, write and schedule marketing content, and publishes it to the social
        accounts you connect. It acts on your instruction — it does not post anything you have not
        created or scheduled.
      </p>

      <h2>Your account</h2>
      <p>
        You must be 18 or older. Keep your password secure and tell us promptly if you suspect
        someone else has access. You are responsible for what happens under your account, including
        actions by members you invite to your workspace.
      </p>

      <h2>Your content</h2>
      <p>
        You own everything you create in GODEYE, including AI-generated drafts. You grant us only
        the permission needed to run the service — to store your content, and to transmit it to the
        platforms you have connected when you tell us to publish.
      </p>

      <h2>Your responsibilities</h2>
      <p>You agree not to use GODEYE to:</p>
      <ul>
        <li>post content you do not have the rights to;</li>
        <li>break the terms of any connected platform, or its automation and spam rules;</li>
        <li>publish unlawful, deceptive, harassing or hateful content;</li>
        <li>impersonate anyone, or misrepresent an affiliation;</li>
        <li>send bulk unsolicited messages;</li>
        <li>attempt to breach or disrupt the service or another user&rsquo;s workspace.</li>
      </ul>
      <p>
        You remain responsible for everything published through your connected accounts, including
        AI-generated content. <strong>Review before you publish.</strong>
      </p>

      <h2>AI-generated content</h2>
      <p>
        GODEYE uses large language models to draft content. AI output can be inaccurate, generic, or
        unsuitable for your context. We do not warrant that generated content is accurate, original
        or fit for any purpose, and we are not liable for what you choose to publish. Check facts,
        claims and figures before posting.
      </p>

      <h2>Third-party platforms</h2>
      <p>
        Facebook, Instagram, X, LinkedIn, Reddit, Telegram and Discord are independent services with
        their own terms. We are not responsible for their availability, their decisions, or any
        action they take against your account. A platform may change or withdraw its API at any
        time, which can stop a GODEYE feature working through no fault of ours.
      </p>

      <h2>Plans and payment</h2>
      <p>
        Paid plans, where offered, are billed in advance for the period shown at checkout. Plan
        limits (such as scheduled posts or connected accounts) are enforced in the app. You can
        cancel at any time and keep access until the end of the paid period. We do not give refunds
        for partial periods unless the law requires it.
      </p>

      <h2>Availability</h2>
      <p>
        We aim to keep GODEYE running but do not guarantee uninterrupted service. Features may
        change, and we may suspend accounts that breach these terms or put the service at risk.
      </p>

      <h2>Liability</h2>
      <p>
        GODEYE is provided &ldquo;as is&rdquo;. To the extent permitted by law, we are not liable for
        indirect or consequential loss, lost profits, lost data, or damage arising from content
        published through the service. Nothing here limits liability that cannot lawfully be limited.
      </p>

      <h2>Ending your use</h2>
      <p>
        You may stop and delete your account at any time — see <a href="/data-deletion">Data deletion</a>.
        We may suspend or close an account that breaches these terms, and will tell you why unless
        prevented by law.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. Material changes will be notified in the app or by email, and the
        date above will change. Continuing to use GODEYE after that means you accept the new terms.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:tysonmulwa25@gmail.com">tysonmulwa25@gmail.com</a>
      </p>
    </>
  );
}
