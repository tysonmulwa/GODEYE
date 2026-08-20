# Cross-site request forgery

**Finding S-14 · CWE-352 · OWASP ASVS 5.0 V4.2.2 · API Security Top 10 API8:2023**

## What was wrong

`/auth/refresh` and `/auth/logout` are authenticated by the refresh cookie and
nothing else. They have to be — there is no access token to present at the
moment you are asking for a new one, which is why both carry `@Public()`.

When `WEB_URL` and `API_URL` are on different registrable domains the session
cookie must be `SameSite=None` or the browser drops it on every reload. That is
how GODEYE is deployed today (`godeyeautomation.com` +
`api.godeyeautomation.com` are same-site, but the split-domain configuration is
supported and was live for weeks). At `SameSite=None`, this is the entire
exploit:

```html
<form action="https://api.godeyeautomation.com/auth/logout" method="POST"></form>
<script>document.forms[0].submit()</script>
```

No token to steal, no timing window, nothing installed on the victim's machine.
A POST with no custom header is a CORS **simple request**: there is no
preflight to fail, the browser attaches the cookie, and the server runs the
handler. CORS withholds the *response* from the attacking page — which is the
part that makes this finding easy to dismiss. The side effect has already
happened.

Three concrete harms, in ascending order:

1. **Forced logout.** Annoying, and hard to attribute.
2. **Forced refresh.** Rotation carries reuse detection. A forced rotation
   racing the real tab makes that tab present a token which has already been
   spent, the alarm fires, and the **entire session family is revoked** — so a
   page the victim merely visited can end every session they hold.
3. **Login CSRF.** The attacker POSTs their *own* credentials to `/auth/login`.
   The victim's browser accepts the resulting session cookie and the victim
   then composes posts, connects their Facebook page and uploads media inside a
   workspace the attacker can read whenever they like. Nothing of the victim's
   is needed to start it. Same shape on `/auth/accept-invitation`.

## The rule

One rule, global, in [`csrf.guard.ts`](../../apps/api/src/common/csrf.guard.ts):

> An unsafe method, with no bearer token, on a route that is not exempt, must
> carry an `Origin` (or `Referer`) on the allow-list.

Registered as the **first** global guard, ahead of `RolesGuard` and the
throttler, because it reads three request headers and touches neither Postgres
nor Redis — a forged request should cost as little as possible to refuse.

Global rather than per-route for the reason S-1 exists: per-controller wiring is
a decision every future developer has to get right, and five of them did not.

### The three escapes

| Escape | Why it is sound |
|---|---|
| `GET` / `HEAD` / `OPTIONS` | They change nothing, and gating them would break every OAuth callback — those are GETs arriving from Meta, TikTok, LinkedIn and Reddit. A `GET` that *does* change something is a different defect; `RouteAuditService` is where that gets caught. |
| `Authorization: Bearer <token>` | An attacker's page cannot set that header cross-origin without a preflight, and the preflight is answered by the same allow-list this guard uses. A request holding a bearer is same-origin, from an approved origin, or not from a browser — and in the last case the attacker already needed the token, which is theft, not forgery. |
| `@CsrfExempt(reason)` | For endpoints authenticated by a signature rather than by an ambient credential. Exactly two: the Meta and Paystack webhooks. |

The word "Bearer" alone is not a token — `Bearer ` with nothing after it is
refused. A `startsWith("Bearer")` check would have been a free bypass of the
entire guard.

### Fail closed

Absent `Origin` **and** absent `Referer` is a denial. The tempting reading is
"no Origin means same-origin, which is safe"; it does not. Non-browser clients
send none, and so do some cross-origin redirect chains. "Cannot tell" is not
"safe" — directive §1.8.

`Origin: null` — sandboxed iframes, some redirected cross-origin POSTs — is an
opaque origin. It fails the URL parse, lands as `null`, and matches no entry.

## What this changes for callers

**Browsers: nothing.** A browser sets `Origin` on every state-changing request
without being asked.

**Non-browser clients calling `/auth/login`** must send one:

```bash
curl -X POST https://api.godeyeautomation.com/auth/login \
  -H 'Origin: https://godeyeautomation.com' \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}'
```

Every other route is bearer-authenticated and needs no change.

## One list, not two

The allow-list comes from [`env.allowedOrigins()`](../../apps/api/src/common/env.ts),
which CORS in `main.ts` now calls as well. Two copies drift, and a drift here is
not cosmetic:

- an origin CORS accepts but the CSRF guard rejects **breaks the product**
- an origin the CSRF guard accepts but CORS rejects **silently reopens S-14**

It also normalises each entry to a bare `scheme://host[:port]` — the exact shape
of an `Origin` header. Previously CORS compared the raw `WEB_URL` string, so a
value carrying a path would never have matched a browser's origin, and the
failure would have read as a CORS problem rather than a configuration one.

Comparison is whole-string equality against that normalised origin. Never a
prefix, never a suffix, never `endsWith`:

| Rejected | Why it matters |
|---|---|
| `https://evil.godeyeautomation.com` | A subdomain takeover — a stale CNAME, an abandoned preview deploy — would otherwise be a total bypass |
| `https://godeyeautomation.com.evil.com` | The classic suffix trick |
| `http://godeyeautomation.com` | Scheme is part of an origin; a downgrade must not inherit trust |
| `https://godeyeautomation.com@evil.com` | Userinfo. The parser reads the host as `evil.com`, which is correct, and the comparison then fails |

`https://godeyeautomation.com:443` **is** allowed. It is the same origin, and
the URL parser drops the default port.

## Evidence

| | |
|---|---|
| [`s14-csrf.exploit.spec.ts`](../../apps/api/test/exploits/s14-csrf.exploit.spec.ts) | 16 tests over real HTTP. **9 were RED** on the parent commit. Includes the verbatim `<form>` exploit, login CSRF, and the four near-miss origins |
| [`csrf.guard.spec.ts`](../../apps/api/src/common/csrf.guard.spec.ts) | 42 assertions on the decision function and origin normalisation |
| Boot log | Every exempt route is named at startup, with its reason |
| Inventory test | The exempt set must equal exactly the two webhooks. Adding a third fails CI |

The inventory test is the part that matters over time. Every escape from a
global security control is a place the control does not apply, and the failure
mode is not a bug — it is somebody adding `@CsrfExempt` to make a test pass,
and nobody ever seeing it.

## What this is not

- **Not a token-based defence.** No synchroniser token, no double-submit
  cookie. Origin validation is what the OWASP cheat sheet recommends for an API
  consumed by a SPA, and it needs no server state, no hidden field, and nothing
  for the frontend to remember.
- **Not a substitute for `SameSite`.** The cookie is still `Lax` whenever the
  deployment is same-site. This is the layer beneath it, for the cross-site
  configuration where `Lax` is not available.
- **Not protection against XSS.** Script running on an allowed origin sends an
  allowed `Origin`. That is CSP's job, and CSP is
  [still open](../audit/FINDINGS.md).
