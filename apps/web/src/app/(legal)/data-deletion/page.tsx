import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data Deletion — GODEYE",
  description: "How to delete your GODEYE data, or data GODEYE holds from a connected platform.",
};

export default function DataDeletionPage() {
  return (
    <>
      <h1>Data Deletion</h1>
      <p className="lead">
        You can remove your data from GODEYE at any time. Here are the three ways, depending on how
        much you want gone.
      </p>

      <h2>1. Disconnect a single social account</h2>
      <p>
        In GODEYE, go to <strong>Connections</strong> and click the bin icon on the account you want
        removed.
      </p>
      <p>
        The stored access tokens for that account are deleted immediately, and GODEYE loses all
        ability to see or post to it. Posts already published stay on the platform — they belong to
        your account there, and only you can remove them.
      </p>

      <h2>2. Revoke access from the platform&rsquo;s side</h2>
      <p>
        You can also cut GODEYE off from the platform itself, which works even if you can&rsquo;t
        sign in to GODEYE:
      </p>
      <ul>
        <li>
          <strong>Facebook / Instagram:</strong> Facebook → Settings &amp; Privacy → Settings →
          Business Integrations → GODEYE → Remove.
        </li>
        <li>
          <strong>LinkedIn:</strong> Settings → Data Privacy → Permitted Services → GODEYE → Remove.
        </li>
        <li>
          <strong>Reddit:</strong> Preferences → Apps → GODEYE → Revoke access.
        </li>
        <li>
          <strong>X:</strong> Settings → Security and account access → Apps and sessions → GODEYE →
          Revoke.
        </li>
        <li>
          <strong>Telegram / Discord:</strong> delete or regenerate the bot token via @BotFather or
          the Discord Developer Portal.
        </li>
      </ul>
      <p>
        Revoking on the platform invalidates the token immediately. Any copy GODEYE still holds
        becomes useless, and is removed when you delete the connection or your account.
      </p>

      <h2>3. Delete your entire GODEYE account</h2>
      <p>
        Email <a href="mailto:tysonmulwa25@gmail.com">tysonmulwa25@gmail.com</a> from the address
        registered on the account, with the subject <strong>&ldquo;Delete my account&rdquo;</strong>.
      </p>
      <p>We will confirm within 7 days and complete deletion within 30 days. That removes:</p>
      <ul>
        <li>your account, name, email and password hash;</li>
        <li>your business profile and brand kit;</li>
        <li>every connected account and its encrypted tokens;</li>
        <li>all content, drafts, scheduled posts and generated variants;</li>
        <li>all uploaded and generated images;</li>
        <li>stored engagement figures and SEO audits.</li>
      </ul>
      <p>
        The only thing we may keep is a minimal record where the law requires it (for example,
        billing records for tax purposes). It is not used for anything else.
      </p>

      <h2>What we cannot delete</h2>
      <p>
        Posts that were already published to Facebook, Instagram, X or anywhere else live on that
        platform under your account. GODEYE cannot remove them once your connection is gone — delete
        those directly on the platform.
      </p>

      <h2>Questions</h2>
      <p>
        <a href="mailto:tysonmulwa25@gmail.com">tysonmulwa25@gmail.com</a> — we answer deletion
        requests first.
      </p>
    </>
  );
}
