import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — GODEYE",
  description: "How GODEYE collects, uses, stores and deletes your data.",
};

const UPDATED = "26 July 2026";

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="lead">Last updated: {UPDATED}</p>

      <p>
        GODEYE is an AI marketing tool. You connect your own social media accounts, GODEYE
        helps you write and schedule posts, and it publishes them to those accounts on your
        instruction. This policy explains exactly what we store, why, and how to get rid of it.
      </p>

      <h2>Who we are</h2>
      <p>
        GODEYE (&ldquo;we&rdquo;, &ldquo;the service&rdquo;) is operated by Tyson Mulwa. For any
        privacy question or request, contact <a href="mailto:tysonmulwa25@gmail.com">tysonmulwa25@gmail.com</a>.
      </p>

      <h2>What we collect</h2>
      <h3>Account information</h3>
      <p>
        Your name and email address, and a cryptographic hash of your password — we never store
        the password itself. If you enable two-factor authentication, the TOTP secret is stored
        encrypted.
      </p>

      <h3>Business profile</h3>
      <p>
        Whatever you choose to tell us about your business or creator profile: description,
        industry, audience, location, website, products and services. This is used as context so
        the AI writes relevant content. You provide it; you can change or remove it at any time.
      </p>

      <h3>Connected social accounts</h3>
      <p>
        When you connect a platform (Facebook, Instagram, Telegram, Reddit, LinkedIn, X, Discord)
        we store the access tokens that platform issues, plus the account or page name and its ID
        so we can show you what is connected.
      </p>
      <p>
        <strong>All platform tokens are encrypted at rest using AES-256-GCM.</strong> They are
        decrypted only at the moment we make a request you asked for — publishing a post you
        scheduled, or reading back that post&rsquo;s engagement figures.
      </p>

      <h3>Content and media</h3>
      <p>
        The posts you write or generate, your hashtags and variants, images you upload or
        generate, and your scheduling calendar.
      </p>

      <h3>Performance data</h3>
      <p>
        For posts published through GODEYE, we retrieve public engagement counts (likes,
        comments, shares) from the platform so we can show you how a post performed.
      </p>

      <h3>Operational logs</h3>
      <p>
        A record of significant account actions (sign-ins, connecting or disconnecting an account,
        publishing) for security and troubleshooting.
      </p>

      <h2>What we do NOT do</h2>
      <ul>
        <li>We do not sell your data, and we never have.</li>
        <li>We do not use your content or your audience&rsquo;s data for advertising.</li>
        <li>We do not train AI models on your content.</li>
        <li>
          We do not read your private messages, your friends list, or anyone else&rsquo;s personal
          data. We request only the permissions needed to list your pages and publish to them.
        </li>
        <li>We do not post anything you did not create or schedule.</li>
      </ul>

      <h2>Meta Platform data (Facebook &amp; Instagram)</h2>
      <p>
        If you connect Facebook or Instagram, we request only these permissions, each for a single
        purpose:
      </p>
      <ul>
        <li>
          <code>pages_show_list</code> — to show you which Pages you can post to.
        </li>
        <li>
          <code>pages_manage_posts</code> — to publish the posts you schedule.
        </li>
        <li>
          <code>pages_read_engagement</code> — to read back likes and comments on those posts.
        </li>
        <li>
          <code>instagram_basic</code> — to identify the Instagram Business account linked to your Page.
        </li>
        <li>
          <code>instagram_content_publish</code> — to publish the posts you schedule to Instagram.
        </li>
        <li>
          <code>business_management</code> — to list Pages held in your Business Manager.
        </li>
      </ul>
      <p>
        Meta Platform data is used solely to provide these features to you, is never transferred to
        a data broker or ad network, and is deleted when you disconnect the account or delete your
        GODEYE account.
      </p>

      <h2>Where your data lives</h2>
      <p>
        The database and file storage are hosted on Supabase (Amazon Web Services, Canada Central).
        The application runs on Vercel and Railway. Content generation uses Anthropic&rsquo;s Claude
        API; the text of your brief and business profile is sent to Anthropic to produce the draft,
        and per Anthropic&rsquo;s API terms it is not used to train their models.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Your data is kept while your account is open. Disconnect a social account and its tokens are
        deleted immediately. Delete your account and everything associated with it is removed within
        30 days, except where we must retain a record to comply with the law.
      </p>

      <h2>Your rights</h2>
      <p>
        You can access, correct, export or delete your data at any time — most of it directly in the
        app, and anything else by emailing us. See{" "}
        <a href="/data-deletion">Data deletion</a> for how to remove your data. If you are in the EU
        or UK, you also have the right to object to processing and to lodge a complaint with your
        data protection authority.
      </p>

      <h2>Security</h2>
      <p>
        Passwords are hashed with Argon2id. Platform tokens are encrypted with AES-256-GCM. All
        traffic runs over HTTPS. Access to your workspace is limited to the members you invite, with
        the role you assign them.
      </p>
      <p>
        No system is perfectly secure. If we discover a breach affecting your data, we will tell you
        and the relevant authority without undue delay.
      </p>

      <h2>Children</h2>
      <p>GODEYE is not intended for anyone under 18, and we do not knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>
        If we change this policy we will update the date above, and for material changes we will
        notify you in the app or by email.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or requests: <a href="mailto:tysonmulwa25@gmail.com">tysonmulwa25@gmail.com</a>
      </p>
    </>
  );
}
