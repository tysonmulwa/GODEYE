import { TRIAL_HOURS } from "@godeye/shared";
import { env } from "../common/env";
import type { EmailMessage } from "./email.service";

/**
 * The transactional emails, as plain functions.
 *
 * ## Both parts, always
 *
 * Every template returns `html` and `text`. A message with no text part is
 * scored as spam by most filters, renders as an empty box in clients with
 * images and HTML off, and is unreadable in a screen reader that has chosen
 * plain text. The text version is not a fallback nobody sees; for some people
 * it is the only version.
 *
 * ## Inline styles, tables, no CSS file
 *
 * Email clients are not browsers. Gmail strips `<style>` blocks in some
 * contexts, Outlook renders through Word, and neither supports flexbox or
 * custom properties. So this is inline styles on tables, which is ugly to read
 * and is the thing that actually arrives looking right.
 *
 * ## No tracking pixel, no click wrapping
 *
 * Not an oversight. These are transactional messages to people who are already
 * customers, and adding surveillance to a password reset is not a trade worth
 * making.
 */

const BRAND = "#7c6bf7";
const INK = "#16150f";
const MUTED = "#6a675c";
const BORDER = "#e4e2dc";

function layout(heading: string, bodyHtml: string, action?: { label: string; url: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f3ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ef;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;">
<tr><td style="padding:28px 32px 0;">
<span style="font-size:15px;font-weight:700;letter-spacing:.18em;color:${INK};">GODEYE</span>
</td></tr>
<tr><td style="padding:20px 32px 0;">
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:${INK};font-weight:700;">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
${
  action
    ? `<tr><td style="padding:26px 32px 0;">
<a href="${escapeAttr(action.url)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600;font-size:15px;">${escapeHtml(action.label)}</a>
</td></tr>
<tr><td style="padding:16px 32px 0;">
<p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">If the button does not work, paste this into your browser:<br>
<span style="word-break:break-all;color:${MUTED};">${escapeHtml(action.url)}</span></p>
</td></tr>`
    : ""
}
<tr><td style="padding:28px 32px 30px;">
<p style="margin:0;border-top:1px solid ${BORDER};padding-top:16px;font-size:12px;line-height:1.6;color:${MUTED};">
GODEYE, operated by GODEYE Automation Services.<br>
Questions: <a href="mailto:contact@godeyeautomation.com" style="color:${MUTED};">contact@godeyeautomation.com</a>
</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:#3f3d36;">${text}</p>`;
}

/** Escaped because names and business names come from user input. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

// ---------------------------------------------------------------------------

export function welcomeEmail(to: string, name: string): EmailMessage {
  // Raw: `layout` escapes the heading. Escaping here as well put
  // "&amp;lt;script&amp;gt;" in the inbox instead of the person's name.
  const displayName = name.trim() || "there";
  const url = `${env.webUrl}/dashboard`;
  return {
    to,
    template: "welcome",
    subject: `Welcome to GODEYE`,
    html: layout(
      `Welcome, ${displayName}`,
      p(`Your workspace is ready, with <strong>${TRIAL_HOURS} hours of the full product</strong> and no card needed.`) +
        p("Connect a channel and GODEYE will write for it, make the images and video, and publish on a schedule it works out from your own results.") +
        p("The fastest first step is connecting one account. Everything else follows from there."),
      { label: "Open your workspace", url },
    ),
    text: [
      `Welcome, ${name.trim() || "there"}`,
      "",
      `Your workspace is ready, with ${TRIAL_HOURS} hours of the full product and no card needed.`,
      "",
      "Connect a channel and GODEYE will write for it, make the images and video, and",
      "publish on a schedule it works out from your own results.",
      "",
      `Open your workspace: ${url}`,
      "",
      "GODEYE, operated by GODEYE Automation Services.",
      "Questions: contact@godeyeautomation.com",
    ].join("\n"),
  };
}

/**
 * The reset link.
 *
 * The token is in the URL because that is the only place a link can carry it.
 * Everything that makes that safe lives elsewhere: single use, a short expiry,
 * and only the hash is stored, so this message is the one and only copy.
 */
export function passwordResetEmail(to: string, resetUrl: string, minutes: number): EmailMessage {
  return {
    to,
    template: "password-reset",
    subject: "Reset your GODEYE password",
    html: layout(
      "Reset your password",
      p(`Use the button below to choose a new password. The link works once and expires in <strong>${minutes} minutes</strong>.`) +
        p("If you did not ask for this, you can ignore this email. Your password will not change, and nobody can start a reset without access to this inbox."),
      { label: "Choose a new password", url: resetUrl },
    ),
    text: [
      "Reset your password",
      "",
      `Use the link below to choose a new password. It works once and expires in ${minutes} minutes.`,
      "",
      resetUrl,
      "",
      "If you did not ask for this, ignore this email. Your password will not change.",
      "",
      "GODEYE, operated by GODEYE Automation Services.",
    ].join("\n"),
  };
}

export function passwordChangedEmail(to: string): EmailMessage {
  const url = `${env.webUrl}/login`;
  return {
    to,
    template: "password-changed",
    subject: "Your GODEYE password was changed",
    html: layout(
      "Your password was changed",
      p("This is a confirmation that the password on your GODEYE account has just been changed.") +
        p("<strong>If this was not you</strong>, reset your password immediately and check the connected accounts on your workspace."),
      { label: "Sign in", url },
    ),
    text: [
      "Your password was changed",
      "",
      "This confirms the password on your GODEYE account has just been changed.",
      "",
      "If this was not you, reset your password immediately and check the connected",
      "accounts on your workspace.",
      "",
      url,
    ].join("\n"),
  };
}

export function purchaseEmail(
  to: string,
  detail: { planName: string; amount: string; reference: string; paidUntil?: Date | null },
): EmailMessage {
  const url = `${env.webUrl}/billing`;
  const until = detail.paidUntil
    ? detail.paidUntil.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  return {
    to,
    template: "purchase",
    subject: `Your GODEYE ${detail.planName} plan is active`,
    html: layout(
      `${detail.planName} is active`,
      p(`Payment of <strong>${escapeHtml(detail.amount)}</strong> received. Your workspace is on the ${escapeHtml(detail.planName)} plan.`) +
        (until ? p(`Active until <strong>${escapeHtml(until)}</strong>.`) : "") +
        p(`Reference: <span style="font-family:ui-monospace,Menlo,monospace;">${escapeHtml(detail.reference)}</span>`),
      { label: "View billing", url },
    ),
    text: [
      `${detail.planName} is active`,
      "",
      `Payment of ${detail.amount} received. Your workspace is on the ${detail.planName} plan.`,
      until ? `Active until ${until}.` : "",
      `Reference: ${detail.reference}`,
      "",
      `View billing: ${url}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export interface WeeklySummary {
  published: number;
  scheduled: number;
  failed: number;
  topPlatform: string | null;
  seoScore: number | null;
}

/**
 * The weekly review.
 *
 * Every figure is counted from that workspace's own rows. There is no
 * "engagement up 40%" line, because nothing in the product measures a baseline
 * to compare against, and a made-up number in a recurring email is a lie told
 * every week.
 */
export function weeklyReviewEmail(
  to: string,
  orgName: string,
  summary: WeeklySummary,
): EmailMessage {
  const url = `${env.webUrl}/dashboard`;
  const rows: Array<[string, string]> = [
    ["Published", String(summary.published)],
    ["Scheduled for next week", String(summary.scheduled)],
  ];
  if (summary.failed > 0) rows.push(["Failed", String(summary.failed)]);
  if (summary.topPlatform) rows.push(["Most used channel", summary.topPlatform]);
  if (summary.seoScore !== null) rows.push(["SEO score", String(summary.seoScore)]);

  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:4px 0 0;">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid ${BORDER};font-size:14px;color:${MUTED};">${escapeHtml(label)}</td><td align="right" style="padding:9px 0;border-bottom:1px solid ${BORDER};font-size:15px;font-weight:600;color:${INK};">${escapeHtml(value)}</td></tr>`,
    )
    .join("")}</table>`;

  const lead =
    summary.published === 0
      ? p("Nothing published for this workspace in the last seven days.")
      : p(
          `GODEYE published <strong>${summary.published}</strong> ${summary.published === 1 ? "post" : "posts"} for ${escapeHtml(orgName)} in the last seven days.`,
        );

  return {
    to,
    template: "weekly-review",
    subject: `GODEYE weekly review: ${summary.published} published`,
    html: layout("Your week", lead + table, { label: "Open your workspace", url }),
    text: [
      "Your week",
      "",
      summary.published === 0
        ? "Nothing published for this workspace in the last seven days."
        : `GODEYE published ${summary.published} post(s) for ${orgName} in the last seven days.`,
      "",
      ...rows.map(([label, value]) => `${label}: ${value}`),
      "",
      url,
      "",
      "To stop these, turn off the weekly review in your workspace settings.",
    ].join("\n"),
  };
}
