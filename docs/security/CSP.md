# Content Security Policy and response headers

**OWASP ASVS 5.0 V14.4 · CWE-1021 · CWE-79**

## What was missing

The web app shipped with **no security response headers at all**. No CSP, no
`frame-ancestors`, no `Referrer-Policy`, no `Permissions-Policy`, no `nosniff`.
There was no `middleware.ts` and `next.config.ts` declared no `headers()`.

Concretely, before this change:

- Any page on the internet could put the dashboard in an invisible iframe over
  its own bait. The billing page has an **upgrade** button.
- A single injected `<script>` had nothing between it and every session, every
  connected social account, and the media library.
- The OAuth callback URL — which carries `state` and `code` in its query string
  — travelled onward in a `Referer` header under the browser default. That is
  the leak path finding C-1 turned into a session compromise.
- An uploaded file that claims to be a PNG and is really HTML would be sniffed
  and executed same-origin, because customers upload files here.

## What ships enforcing today

| Header | Value |
|---|---|
| `Content-Security-Policy` | `base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (production only) |

Every directive in that CSP is one with no failure mode for this application:
nothing embeds a plugin, rewrites its own base URL, posts a form cross-origin,
or wants to be inside somebody else's frame. Clickjacking is closed as of this
commit.

`preload` is deliberately absent from HSTS — it is slow and awkward to reverse,
and that is not this change's decision to make. HSTS is never sent in
development: a browser told that `localhost` is HTTPS-only stays that way for a
year, and no server-side change undoes it.

## 🔴 What does NOT ship enforcing, and why

The full policy — `script-src` with a nonce and `'strict-dynamic'`,
`connect-src`, `img-src`, `frame-src 'none'` and the rest — is sent as
**`Content-Security-Policy-Report-Only`**.

This is not caution for its own sake. **Enforcing it today would white-screen
the product**, and that is measured rather than assumed:

```console
$ next build
   ...
   ○  (Static)   prerendered as static content       # every page

$ grep -c 'nonce='  .next/server/app/pricing.html
0
$ grep -c '<script>' .next/server/app/pricing.html
14
```

Every page in this app prerenders. A prerendered page is HTML written at build
time, when there is no request and therefore no nonce — and Next's own RSC
payload arrives as fourteen inline `self.__next_f.push(...)` blocks per page.
Under `'strict-dynamic'` a browser refuses all fourteen, and the page never
hydrates.

Three ways out, in order of preference:

1. **Render the app shell dynamically.** Next stamps the nonce at request time
   for dynamically rendered routes, so the authenticated `(app)` routes could
   enforce today while the marketing pages stay static under the baseline. This
   is the right answer and it is a performance decision that deserves its own
   change.
2. **Hashes instead of nonces.** Impractical here: the RSC payload differs per
   page and per build, so the hash set would have to be regenerated on every
   deploy.
3. **`'unsafe-inline'` in `script-src`.** Do not. It disables the entire policy
   as an XSS defence, which is the single most common thing to find in a real
   CSP — usually added to fix one widget and never removed.

## Promoting it

Enforcement is a variable, not a code change, so it can be undone in seconds:

```bash
# Cloudflare -> Workers & Pages -> the web app -> Settings -> Variables
CSP_ENFORCE=true
```

Before flipping it:

- [ ] Resolve the static-rendering problem above. Flipping this first blanks
      every page — this is the whole reason the flag exists rather than the
      policy simply being enforcing.
- [ ] Load every route with devtools open and the console filtered to CSP:
      dashboard, composer, calendar, connections, SEO, billing, onboarding,
      settings, team, and the public marketing pages.
- [ ] Confirm realtime works. Socket.IO opens with HTTP polling and upgrades,
      so a missing `wss:` shows up as "the app feels slow", not as an error.
- [ ] Confirm generated images and video still render — `img-src`/`media-src`
      allow `https:` precisely because those hosts are chosen at runtime.
- [ ] Complete one OAuth connect and one Paystack checkout. Both are full-page
      redirects, so `frame-src 'none'` should be invisible; verify rather than
      assume.

To roll back: unset the variable. The baseline stays enforcing throughout.

## Decisions worth stating

**`'unsafe-inline'` for styles, deliberately.** `next/font` injects a `<style>`
block and framer-motion writes inline style attributes on every animated
element. Nonce-ing those means opting every page out of static rendering to
read the nonce — a real cost against a small threat, because a stylesheet
cannot execute. What it leaves open is CSS-based exfiltration of
already-rendered content, which needs the script injection `script-src` exists
to prevent.

**`https:` for images and media, deliberately.** Customer media is served from
whichever S3-compatible host a workspace is configured against, and generated
video URLs are minted by the engine at runtime. An allow-list here would be a
broken product every time that changes. An image is not a script.

**Fonts are local.** `next/font/google` downloads Inter, JetBrains Mono and
Michroma at build time, so nothing is fetched from Google at runtime and
`fonts.gstatic.com` does not belong in the policy.

**JSON-LD is not nonce'd.** The four `<script type="application/ld+json">`
blocks are data blocks — a non-executable MIME type is never run, so
`script-src` does not apply. If the report-only run says otherwise, that is
exactly what the dry run is for.

## Evidence

[`csp.test.ts`](../../apps/web/src/test/csp.test.ts) — 25 assertions on the
policy string, including the two that matter most:

- `script-src` never contains `'unsafe-inline'`, in either mode
- `'unsafe-eval'` is present in development and absent in production

and one that records why the baseline is scoped the way it is: `script-src`
must stay out of the always-enforcing set while pages prerender.

The policy lives in [`lib/csp.ts`](../../apps/web/src/lib/csp.ts) as pure
functions rather than inside the middleware, because header construction is
exactly the kind of code that looks right in a diff and is off by one directive.
