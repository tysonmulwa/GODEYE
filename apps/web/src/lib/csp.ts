/**
 * Security response headers for the web app.
 *
 * The frontend shipped with none of these. No Content-Security-Policy, no
 * `frame-ancestors`, no `Referrer-Policy`, no `Permissions-Policy` — so any
 * page on the internet could frame the dashboard, and a single injected
 * `<script>` had nothing standing between it and every session in the product.
 *
 * Kept as pure functions, separate from `middleware.ts`, so the policy can be
 * asserted against a table rather than by loading a page and squinting at
 * devtools. Header construction is exactly the kind of code that looks right
 * and is off by one directive.
 *
 * OWASP ASVS 5.0 V14.4, CWE-1021 (clickjacking), CWE-79 (XSS mitigation).
 */

export interface PolicyInput {
  /** Per-response, per-request. Reused nonces are the same as no nonce. */
  nonce: string;
  /** Where the API lives — needs to be reachable by fetch and by Socket.IO. */
  apiUrl: string;
  isDev: boolean;
}

/**
 * The directives that cannot break a working application, ever.
 *
 * These ship **enforcing** from the first deploy, because there is no failure
 * mode to discover: nothing in GODEYE embeds a plugin, rewrites its own base
 * URL, posts a form to another origin, or wants to be inside somebody else's
 * iframe.
 *
 * `frame-ancestors 'none'` is the one with a name: it is the clickjacking
 * defence, and until now the billing page — with its "upgrade" button — could
 * be framed invisibly over any bait a phishing page cared to draw.
 */
export function baselinePolicy(): string {
  return [
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * The full policy — **report-only today, and for a measured reason.**
 *
 * Enforcing this would white-screen the product. Every page in this app builds
 * as `○ (Static)`, and a prerendered page is HTML written at build time, when
 * there is no request and therefore no nonce. Checked rather than assumed:
 *
 *     $ grep -c 'nonce=' .next/server/app/pricing.html
 *     0
 *     $ grep -c '<script>'  .next/server/app/pricing.html
 *     14
 *
 * Fourteen unnonced inline `self.__next_f.push(...)` blocks — Next's own RSC
 * payload — on every prerendered page. Under `'strict-dynamic'` a browser
 * refuses all fourteen and the page never hydrates.
 *
 * The way out is to render dynamically so Next can stamp the nonce at request
 * time, which is a performance decision about the marketing pages and not one
 * to make as a side effect of a security header. Until then this ships as
 * `Content-Security-Policy-Report-Only` and the baseline above does the
 * enforcing. `CSP_ENFORCE=true` promotes it; docs/security/CSP.md carries the
 * order of operations.
 *
 * `'strict-dynamic'` with a nonce rather than a host allow-list: host lists are
 * bypassable through any JSONP endpoint or open redirect on an allowed origin,
 * which is why CSP3 exists. Under `'strict-dynamic'` a CSP3 browser ignores
 * `'self'` and every host in `script-src` — scripts run only if they carry the
 * nonce or were loaded by something that did. `'self'` stays in the list purely
 * as the fallback for a browser that does not understand `'strict-dynamic'`.
 */
export function fullPolicy({ nonce, apiUrl, isDev }: PolicyInput): string {
  const api = origins(apiUrl);

  const directives: string[] = [
    "default-src 'self'",

    // 'unsafe-eval' in development only: React Refresh and the Next dev
    // overlay both need it, and neither exists in a production bundle. Putting
    // it behind isDev means the development experience never becomes an
    // argument for weakening the shipped policy.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,

    // 'unsafe-inline' for styles, deliberately.
    //
    // next/font injects an inline <style> block, and framer-motion writes
    // inline style attributes on every animated element. Nonce-ing those would
    // mean opting every page out of static rendering to read the nonce, which
    // is a real cost against a small threat: a stylesheet cannot execute. The
    // attack it leaves open is CSS-based exfiltration of already-rendered
    // content, which requires the injection this policy's script-src is there
    // to prevent in the first place.
    "style-src 'self' 'unsafe-inline'",

    // Fonts are self-hosted: next/font/google downloads Inter, JetBrains Mono
    // and Michroma at build time, so nothing is fetched from Google at runtime
    // and fonts.gstatic.com does not belong here.
    "font-src 'self' data:",

    // `https:` for images and media is a considered concession, not laziness.
    // Customer media is served from whichever S3-compatible host a workspace is
    // configured against, and generated video URLs are minted by the engine at
    // runtime — an allow-list here would be a broken product every time that
    // changes. An image is not a script; the worst an attacker gets is a
    // pixel-tracking beacon on a page they already had to inject into.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",

    // The API over HTTPS and the same host over WebSocket: Socket.IO opens with
    // HTTP polling and upgrades, so both schemes are needed or realtime silently
    // falls back to polling forever.
    `connect-src 'self' ${api.http} ${api.ws}${isDev ? " ws://localhost:* http://localhost:*" : ""}`,

    // Nothing is embedded. Paystack, Meta, TikTok, LinkedIn and Reddit are all
    // full-page redirects, so there is no checkout iframe to allow for.
    "frame-src 'none'",

    "worker-src 'self' blob:",
    "manifest-src 'self'",
    baselinePolicy(),
  ];

  // Not in development: localhost is http, and this would upgrade every asset
  // request to https and break the dev server outright.
  if (!isDev) directives.push("upgrade-insecure-requests");

  return directives.join("; ");
}

/** `https://api.example.com` -> the http and wss origins Socket.IO needs. */
function origins(apiUrl: string): { http: string; ws: string } {
  try {
    const url = new URL(apiUrl);
    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    return { http: url.origin, ws: `${wsScheme}//${url.host}` };
  } catch {
    // A malformed NEXT_PUBLIC_API_URL must not produce a policy with an empty
    // token in it — `connect-src 'self' ` would silently allow nothing and the
    // app would look broken for a reason nobody could see. 'self' alone is
    // wrong but legible, and the build-time env check is where this belongs.
    return { http: "'self'", ws: "'self'" };
  }
}

/**
 * Every security header, ready to apply.
 *
 * `enforce` decides whether the full policy is a rule or a report. The baseline
 * is always a rule.
 */
export function securityHeaders(
  input: PolicyInput & { enforce: boolean },
): Record<string, string> {
  const full = fullPolicy(input);

  const headers: Record<string, string> = {
    // Sent on every response either way. In report-only mode this is the
    // *baseline*, which is enforcing from day one; the full policy rides
    // alongside it as a report until somebody has watched a real browser load
    // every page under it. See docs/security/CSP.md.
    "Content-Security-Policy": input.enforce ? full : baselinePolicy(),

    // Origin, not full URL, when leaving the site. This is not decoration: the
    // OAuth callback carries `state` and `code` in the query string, and the
    // default policy would send that whole URL onward to whatever the callback
    // page links to (finding C-1's leak path).
    "Referrer-Policy": "strict-origin-when-cross-origin",

    // MIME sniffing turns an uploaded "image" that is really HTML into a
    // same-origin script. GODEYE accepts customer uploads, so this is load
    // bearing rather than boilerplate.
    "X-Content-Type-Options": "nosniff",

    // frame-ancestors supersedes this, but it is one header for the browsers
    // and embedded webviews that never implemented CSP3.
    "X-Frame-Options": "DENY",

    // Nothing in the product uses any of these. Denying them means a compromised
    // dependency cannot quietly ask for a camera on a page the customer trusts.
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  };

  if (!input.enforce) headers["Content-Security-Policy-Report-Only"] = full;

  // HSTS only where it can be honoured. Setting it in development would pin
  // localhost to https in the developer's browser, which is a memorable
  // afternoon and cannot be undone from the server side.
  if (!input.isDev) {
    // No `preload`. Preloading is a commitment that is slow and awkward to
    // reverse, and it is not this change's decision to make.
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}
