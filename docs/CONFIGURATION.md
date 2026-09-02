# Configuration

**Findings:** S-5, S-6, S-6b, S-4. **Evidence:** `apps/api/src/common/secrets.spec.ts`,
`apps/api/test/exploits/s5-s6-s9-config.exploit.spec.ts`, `apps/engine/tests/test_security.py`.

---

## The rule

**A secret has no fallback.** Reading one that is missing, published in this
repository, too short, or entropy-free throws — and it throws at **boot**, not
at the first request that happened to need it.

That is the whole of S-5 and S-6. A variable with a `??` default produces a
*working* system: nothing breaks, nothing warns, and the service is
authenticated by a string anyone can read on GitHub. Both services now refuse to
start instead.

```
Refusing to start: 2 configuration problem(s)
  - ENGINE_INTERNAL_SECRET is set to a value published in this repository. …
  - OAUTH_STATE_SECRET must not equal JWT_ACCESS_SECRET (finding C-1)
```

Validation lives in `apps/api/src/common/secrets.ts` (`validateConfig()`, called
first in `main.ts`) and `apps/engine/.../config.py` (`validate_config()`, called
from the FastAPI lifespan and from `run.py`).

### What is refused

| Check | Why |
|---|---|
| Missing | Nothing to fall back to |
| In `PUBLISHED_DEFAULTS` | A published string can be perfectly random and still be public |
| Under 32 characters | `"ci-access"` was 9 |
| Shannon entropy < 2.5 bits/char | Catches `REPLACE_ME_REPLACE_ME…` |
| A hex key that is one repeated byte | `"a".repeat(64)` and `"00"*32` are format-valid and are not keys |
| A hex key with < 16 distinct byte values | Catches `deadbeef…` |
| A hex key that is a counting sequence | Catches `000102…1f` |
| `OAUTH_STATE_SECRET` == either JWT secret | Reintroduces C-1 exactly, invisibly |
| `JWT_ACCESS_SECRET` == `JWT_REFRESH_SECRET` | Collapses two token classes into one |

### Development

Dev convenience is not removed, it is made explicit:

```bash
NODE_ENV=development
ALLOW_INSECURE_DEV_DEFAULTS=true
```

Both, together. The flag is inert in production — asserted by a test, because
"it only applies in dev" is exactly the kind of claim that turns out to be false
in the incident.

---

## Variables

Blast radius is what breaks if the value is wrong, not what it is for.

### Required — the service will not start without these

| Variable | Service | Type | Blast radius if wrong |
|---|---|---|---|
| `DATABASE_URL` | API, engine | Postgres URL | Total outage |
| `JWT_ACCESS_SECRET` | API | ≥32 chars | Everybody signed out; see [KEY-MANAGEMENT.md](./security/KEY-MANAGEMENT.md) |
| `JWT_REFRESH_SECRET` | API | ≥32 chars | Reserved; must differ from the access secret |
| `OAUTH_STATE_SECRET` | API | ≥32 chars | OAuth flows fail. **Never** the access secret (C-1) |
| `TOKEN_ENCRYPTION_KEY` | API, engine | 64 hex, real entropy | Every stored credential unreadable. Both services must hold the same value |
| `ENGINE_INTERNAL_SECRET` | API, engine | ≥32 chars | API cannot enqueue. Both services must match |
| `INDEXNOW_KEY_SECRET` | engine | ≥32 chars | IndexNow submissions rejected. Must differ from `TOKEN_ENCRYPTION_KEY` (S-6b) |

### Deployment shape

| Variable | Default | Notes |
|---|---|---|
| `TRUST_PROXY_HOPS` | `1` | **A count, never `true`.** `true` lets a client forge `X-Forwarded-For` and mint a fresh rate-limit bucket per request (CWE-348). Railway = 1; add a CDN and it is 2. Verify in staging — [RATE-LIMITING.md](./security/RATE-LIMITING.md) |
| `PORT` / `API_PORT` | `4000` | Container hosts inject `PORT` and route to it |
| `WEB_URL` | `http://localhost:3000` | Comma-separated CORS allow-list, and the redirect target after OAuth |
| `API_URL` | `http://localhost:4000` | Every OAuth `redirect_uri` is derived from this, and it is the JWT `iss` |
| `ENGINE_URL` | `http://localhost:8000` | Where the API enqueues |
| `REDIS_URL` | `redis://localhost:6379/0` | Rate limits, OAuth state, realtime, Celery. See "when Redis is down" below |
| `NODE_ENV` | `development` | `production` turns on `Secure` cookies, fail-closed rate limiting, and turns **off** `/api/docs` |
| `ENABLE_API_DOCS` | unset | Mounts Swagger in production. For a staging box behind auth, never a default (S-9) |
| `ALLOW_INSECURE_DEV_DEFAULTS` | unset | Development only, and only with `NODE_ENV=development` |

### Rotation

| Variable | Default | Notes |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | unset | Comma-separated retired keys, readable but never written. Present **only** during a rotation — leaving it set keeps the old key live |

### Platforms

`META_APP_ID` / `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN`,
`INSTAGRAM_APP_ID` / `_SECRET`, `TIKTOK_CLIENT_KEY` / `_SECRET`,
`LINKEDIN_CLIENT_ID` / `_SECRET`, `REDDIT_CLIENT_ID` / `_SECRET` / `_USER_AGENT`,
`X_API_KEY` / `X_API_SECRET`.

Two notes that have each cost a day:

- **`*_REDIRECT_URI` is optional and usually wrong to set.** It is derived from
  `API_URL`. Providers compare it as a raw string, so a trailing space pasted
  from a dashboard produces an opaque rejection. The code trims and strips
  trailing slashes; setting it by hand reintroduces the risk.
- **`TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` are now needed by the
  ENGINE too**, not just the API. The hourly token-refresh sweep (B-7) renews
  TikTok access tokens, and TikTok rotates the refresh token on every use.

### Payments

`PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_PLAN_{PRO,PREMIUM,VIP}`,
`PAYSTACK_METHODS` (default `card,apple_pay,mpesa`).

Plan codes are scoped to a Paystack **mode**: a `PLN_` created in test mode does
not exist for a live key, and Paystack's answer is the indistinguishable "plan
not found". `GET /health` reports the mode read from the key's own prefix,
which is the fastest way to see it.

---

## When a dependency is down

Stated explicitly, because "fails closed" and "degrades" are different promises
and both appear here.

| Dependency | Production | Development |
|---|---|---|
| Redis — rate limiting | **Refuses the request (503).** A limiter that opens under load is missing exactly when it is needed | Per-process counters, warned once |
| Redis — OAuth state | **Refuses to start the flow (503).** Issuing a state nothing recorded is an unprotected, replayable state | Same |
| Redis — sign-in backoff | Per-account backoff not applied; the per-caller route throttle still is. Logged loudly | Same |
| Redis — leader lock | The periodic sweep is **skipped**. A sweep that runs everywhere when the coordinator is down is the failure mode the lock exists to remove | Same |
| Engine | `/health/ready` reports degraded; enqueues fail fast through the circuit breaker | Same |
| Postgres | Total outage. There is no degraded mode for a database | Same |

---

## Checking a deployment

```bash
# Does it boot, and with what?
curl -s https://api.godeyeautomation.com/health | jq

# Liveness and readiness are separate now (B-4). Point restart policies at
# /health/live — it touches nothing and cannot be slow. Point load balancers
# and deploy gates at /health/ready.
curl -s https://api.godeyeautomation.com/health/live
curl -s https://api.godeyeautomation.com/health/ready
```

`/health` reports booleans about payment configuration — never a key, never a
plan code. "Upgrade does nothing" and "the key is not set on this service" look
identical from a browser, and the answer is one variable either way.

---

## Transactional email (Resend)

Set on the **API service only**. The engine does not send mail.

| Variable | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | For any email at all | Absent, every send is a logged no-op and **password reset cannot work** |
| `EMAIL_FROM` | Recommended | Default `GODEYE <contact@godeyeautomation.com>`. Must be on a domain **verified in Resend** |
| `EMAIL_REPLY_TO` | Optional | Default `contact@godeyeautomation.com` |

Without `RESEND_API_KEY` the API still boots. That is deliberate: a welcome
email must not be able to fail a registration that already wrote a user, an org
and a membership. `EmailService.send()` returns `{ sent: false, reason:
"not-configured" }` and logs a warning once.

The one exception is `sendOrThrow`, used by password reset alone, which raises
rather than pretend. A silent no-op there leaves someone reading "check your
inbox" for a message that was never sent.

### Verifying a domain in Resend lets you SEND, not receive

This catches people out and is worth stating plainly. Adding
`godeyeautomation.com` to Resend and passing its DNS checks means Resend will
accept mail **from** `contact@godeyeautomation.com`. It does **not** create a
mailbox at that address, and mail sent **to** it goes nowhere.

The site publishes `contact@godeyeautomation.com` on the privacy, terms and
data-deletion pages and in the footer of every email, so something has to
receive it. Cheapest option, since the domain is already on Cloudflare:
**Cloudflare Email Routing** (Email → Email Routing) forwards `contact@` to any
existing inbox for free. Resend's own inbound product works too.

A 403 from Resend almost always means the From domain is not verified. It reads
like an auth failure and is not one, so `EmailService` says so in the error.
