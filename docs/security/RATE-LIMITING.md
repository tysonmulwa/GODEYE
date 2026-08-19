# Rate limiting

**Finding:** S-4 (HIGH). **Evidence:** `apps/api/test/exploits/s4-trust-proxy.exploit.spec.ts`.
**Standards:** OWASP API4, NIST SP 800-63B §5.2.2, RFC 9331 (draft `RateLimit-*` headers).

---

## What was wrong

Express `trust proxy` was never enabled — a grep over `apps/api` found no
`app.set("trust proxy", …)` anywhere. Behind Railway's edge that means `req.ips`
is always empty and `req.ip` is the proxy, so **all 26 `@Throttle` overrides and
the global 100/60s collapsed into one bucket for the entire internet**.

That is two failures at once:

- **self-DoS** — 100 requests a minute for the whole API, and the 11th login
  attempt by *anybody* failed
- **failed brute-force control** — an attacker consuming the login bucket locked
  out every legitimate user, and could not be isolated from them

It also poisoned the audit trail: `auth.login` rows recorded the proxy's address,
so every stored IP was the same one.

## What it is now

### `trust proxy` is a hop count

```ts
app.set("trust proxy", env.trustProxyHops);   // TRUST_PROXY_HOPS, default 1
```

**Never `true`.** With `trust proxy: true` Express believes the entire
`X-Forwarded-For` chain, so a client prepends any address it likes and hands
itself a fresh bucket on every request — CWE-348, and a fix that fixes nothing.
With a count, Express takes the nth address from the right and treats everything
to the left as the client's own invention.

Both halves are asserted: two genuine clients get independent buckets, and a
forged chain does **not** get a fresh one.

### Three layers

| Tier | Window | Limit | Keyed by |
|---|---|---|---|
| `default` | 60s | 100 (per-route `@Throttle` overrides tune this) | caller **and** route |
| `burst` | 60s | 600 | caller, across every route |
| `spend` | 1h | 240 units | caller, across every route that declares a `@Cost()` |

`default` per route means exhausting the SEO-audit allowance no longer locks the
caller out of reading their own content. `burst` stops somebody staying under
every individual limit while hammering the API as a whole.

### Who a "caller" is

`u:<userId>:<orgId>` when authenticated, `ip:<client address>` when not.

Identity first, because a shared office NAT is one address and dozens of people,
and an attacker on a residential connection changes address for free. The
address is the fallback only for callers with no session, which is what keeps
`/auth/login` and `/auth/register` protected at all.

### Cost-based quotas

A request that burns 40 seconds of GPU is not equivalent to `GET /auth/me`
(OWASP API4). `@Cost(n)` weights the `spend` bucket:

| Route | Cost | Why |
|---|---|---|
| `POST /media/generate-video` | 25 | TTS, image generation, then an ffmpeg encode that can hold a worker for minutes |
| `POST /seo/audit` | 10 | A crawl of up to `maxPages`, each an outbound request |
| `POST /products/import` | 10 | Fetches and parses a storefront, sometimes through a headless browser |
| `POST /media/generate-image` | 4 | A paid generation plus storage |
| `POST /seo/audits/:id/verify` | 5 | Re-crawls the pages a fix touched |
| `POST /content/generate` | 2 | One LLM call per platform |

Weighting one shared budget beats a second limit per endpoint: a workspace
cannot dodge the cap by spreading spend across several expensive routes.

### Counters live in Redis

The stock storage is a `Map` in the process. On a horizontally-scaled service
that is not rate limiting — N replicas means N times the limit, and a rolling
deploy resets every counter. `RedisThrottlerStorage` uses one atomic Lua
`INCRBY` + `PEXPIRE` per request.

**When Redis is unreachable:** production **refuses the request** (503). A rate
limiter that opens under load is missing exactly when it is needed, and "Redis is
struggling" is the same moment somebody is hammering the login route (§1.8).
Outside production it falls back to per-process counters and logs a warning
once — a developer without Redis should get a working API, not a wall of 503s
that teaches them to disable the limiter.

### Responses

`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response;
`Retry-After` in seconds on every 429. Without `Retry-After` a client's only
strategy is to retry immediately, which turns a rate limit into a retry storm.

### Graduated sign-in backoff

Route throttling caps attempts per caller, which is the wrong axis on its own:
credential stuffing spreads one guess per address across thousands of addresses
and never trips a per-caller limit.

`LoginBackoffService` counts consecutive failures against **the account** and
**the address**: 5 free attempts, then 15s, 30s, 60s, 120s… capped at 15
minutes, forgotten after an hour of quiet, cleared on a successful sign-in.

The cap is not a detail. An unbounded lockout is a denial-of-service anybody can
trigger against a real person just by guessing at their address. A wrong MFA code
counts as a failure too, or the second factor would be guessable at the full
route-throttle rate. The refusal is identical whether or not the account exists
(CWE-204).

## Verifying in staging — required before this is called done

Application-layer reasoning cannot tell you Railway's real hop count. Do this on
a deployed instance:

1. Log `req.ip` and `req.ips` on a request from two genuinely different clients
   (a laptop and a phone on mobile data).
2. Confirm the two `req.ip` values **differ** and neither is a Railway internal
   address.
3. Send `X-Forwarded-For: 1.2.3.4` from one of them and confirm `req.ip` is
   **not** `1.2.3.4`.
4. If a CDN is added in front, raise `TRUST_PROXY_HOPS` to 2 and repeat.

Until step 2 is observed on the real edge, treat the hop count as an assumption.
It is recorded as such in [THREAT-MODEL.md](./THREAT-MODEL.md).
