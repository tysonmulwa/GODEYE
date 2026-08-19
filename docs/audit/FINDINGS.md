# Open findings

What is **not** fixed, and why. Kept separate from the scorecard so nothing has
to be inferred from a score that did not move.

Three categories: things a repository cannot do, things that need a human
decision, and things that are genuinely still to build.

---

## 🔴 Blocked on a human — required before this is finished

These are the reason Security is not scored 10/10.

### 1. Rotate `JWT_ACCESS_SECRET`

Every OAuth `state` GODEYE ever issued was signed with it, and those values are
in Meta's, TikTok's, LinkedIn's and Reddit's logs, in browser history, and in
`Referer` headers. The code stops new ones working as sessions; only rotation
un-issues the old ones.

**Runbook:** [KEY-MANAGEMENT.md § Required now](../security/KEY-MANAGEMENT.md).
**Blast radius:** everyone re-authenticates within 15 minutes. No data touched.

### 2. Confirm production is not running on a published default

`ENGINE_INTERNAL_SECRET` defaulted to `dev-engine-secret` and
`META_WEBHOOK_VERIFY_TOKEN` to `godeye-verify`, on both sides. A deployment that
never set them is authenticated by a string on GitHub. **That is an active
incident, not a code defect** — a service still running the old build still
accepts the default.

### 3. Determine whether `TOKEN_ENCRYPTION_KEY` was ever the all-zeros value

`.env.example` shipped 64 zeros and every validator accepted it. If a live
deployment ever used it, the remedy is **not** re-encryption: every stored
platform credential must be revoked at the provider and reconnected.

### 4. Verify `TRUST_PROXY_HOPS` against the real edge

Application-layer reasoning cannot establish Railway's hop count. Two real
clients must be observed getting different `req.ip` values, and a forged
`X-Forwarded-For` must not produce a third.
**Procedure:** [RATE-LIMITING.md § Verifying in staging](../security/RATE-LIMITING.md).

### 5. Decide the fate of `WebhookEvent`

Nothing reads the table. `processedAt` is written nowhere. It now stores only
signature-verified events and has a 30-day retention sweep, so it is no longer a
liability — but it is still a table with no consumer. Either give it one or drop
it. **Dropping a table is destructive and is not mine to do.**

### 6. Fold case-duplicate accounts and add a `lower(email)` unique index

`emailSchema` now trims and lowercases, so no *new* duplicates can appear. Rows
created before that may already collide (`Tyson@` and `tyson@` as two accounts).
Merging them is a decision about customer data, with a policy question attached:
which account's memberships survive.

```sql
-- Run this first. If it returns nothing, the index can be added safely.
SELECT lower(email), count(*) FROM "User" GROUP BY 1 HAVING count(*) > 1;
```

---

## 🟠 Deliberate deviations from the remediation directive

Each was a case where following the instruction literally would have made the
system worse. Stated here rather than buried.

### `@@unique([action, targetId])` on `AuditLog`

**Directive:** add it, to fix the payment idempotency race (S-8).
**Done instead:** a dedicated `PaymentApplication` table with
`@@unique([provider, reference])`, plus `@@index([action, targetId])` on
`AuditLog` for D-1's half.

**Why:** `connection.updated`, `content.updated` and `account.profile_updated`
all legitimately repeat against the same `targetId`. The constraint as specified
would have started throwing `P2002` when a workspace reconnected a channel or a
user saved their name twice. An audit log records what happened; it must not
also decide whether it may.

### PKCE on every OAuth flow

**Directive:** RFC 7636 on every provider that supports it.
**Done instead:** TikTok only, with the plumbing provider-agnostic and a flag per
provider.

**Why:** Meta, Instagram Login, LinkedIn and Reddit do not document PKCE for the
server-side authorization-code flow. Sending `code_challenge` to a provider that
does not support it risks breaking every customer's connect button, and the
protection it would add is already provided by the single-use, browser-bound,
10-minute state. Each flag flips the day its provider's documentation does.
Details in [OAUTH.md](../security/OAUTH.md).

### Member removal at OWNER

**Directive:** OWNER for member removal.
**Done instead:** `DELETE /members/:userId` is `@MinRole("VIEWER")` at the route,
with `MembersService.remove` requiring ADMIN **and** outranking for removing
somebody else.

**Why:** the route is two operations behind one path, and anyone must be able to
leave a workspace they are in. It is the only entry in the matrix test's
`SERVICE_ENFORCED` list, which is capped at two by an assertion.

### ESLint rules

**Directive:** add lint rules enforcing §1 (no silent catch, no fetch without a
signal, …).
**Done instead:** `scripts/lint-rules.mjs` — six rules, no install step.

**Why:** ESLint is not currently a dependency of this repo, and installing a
toolchain to enforce six rules that span TypeScript *and* Python adds a way for
CI to skip them. The script cannot be skipped by a failed `pnpm install`.
Escapes need a `lint-rules:allow` comment with a reason.

---

## 🟡 Not built — scored honestly rather than claimed

### Observability (rubric row 4, still 2/10)

No OpenTelemetry traces, no RED/USE metrics, no error tracking, no alert rules,
no structured JSON logging. **Nothing in this area was attempted.** It is the
largest remaining gap and it makes every other row harder to prove: there is no
way to observe the rate-limit fail-closed path, the circuit breaker opening, or
the token-refresh failure ratio in production — only in tests.

### Load testing and capacity (row 3, still 4/10)

The publish ceiling (~15–25 posts/hour, from `scheduler.py` and
`--concurrency=2`) is still an inference from reading the code, not a
measurement. No k6 run, no per-tenant fairness in the dispatcher, no isolated
Celery queues.

The unbounded queries D-4 (`abReport` loading an org's entire analytics history)
and D-7 (missing indexes on `ScheduledPost.contentItemId`) are **not fixed**.

### Backups and DR (row 5, still 3/10)

Supabase-managed. No documented RPO/RTO, no verified PITR, and **no restore has
ever been performed**. That is a measurement somebody has to take, once, with a
stopwatch.

### E2E, contract, mutation and DAST testing (row 10)

No Playwright, no ZAP baseline, no mutation testing. The coverage gate the
directive asks for — 85% lines, 100% branch on auth/authorization/billing/crypto
— is not enforced in CI.

### Accessibility (row 13, still 7/10)

No axe run, no manual keyboard or screen-reader pass, no VPAT. The specific gaps
the audit named — no focus trap on the mobile drawer, no `aria-live` on polled
status, no skip link — are **not fixed**. There are still zero frontend tests.

### Infrastructure-layer egress filtering

The SSRF guard is application-layer only. Restricting the worker's outbound
network at the platform layer is defence in depth that a repository cannot add.

### `robots.txt` as a crawl permission

The crawler reads it for sitemap discovery but does not honour it as permission.
That is a legal point as much as a technical one.

---

## 🟢 Noted while working, not in the original audit

| | What | Status |
|---|---|---|
| S-20 | `download_media(url)` — a third SSRF sink, called from five publishers | **Fixed** |
| S-6b | `TOKEN_ENCRYPTION_KEY` also seeded the **public** IndexNow key published on customer sites | **Fixed** — `INDEXNOW_KEY_SECRET` |
| — | `products/supabase_store.py` — a fourth SSRF sink; the backend URL is scraped from the customer's own page HTML | **Fixed** |
| — | The Socket.IO handshake verified tokens with a bare `verifyAsync`, so an OAuth state opened a socket. The socket half of C-1 | **Fixed** |
| — | `.gitignore`'s bare `coverage/` rule silently untracked a coverage artifact | **Fixed** |
| — | `dump.rdb` present in the working tree (never committed — history checked) | Untracked; worth deleting |

### Three false greens in my own exploit suite

Found by inspecting *which* tests passed, not by anything failing. Recorded
because the failure mode is identical to the audit's:

1. Four SSRF targets "refused" — `/seo/audit` is throttled 5/min, so request 6+
   answered **429**, which satisfied "≥400 and the engine was not called".
2. "Connections marked EXPIRED" passed on `meta.py:419` — `if last_status in
   ("ERROR", "EXPIRED")`, a *read* of a status nothing wrote.
3. Two default-secret tests passed because `env.ts` loads the repo-root `.env`,
   so deleting a variable let the developer's **real secret** back in.

A fourth, found later: `disableThrottle` overrode `ThrottlerGuard`, but the guard
is registered as `{ provide: APP_GUARD, useClass: … }`, so `overrideGuard` did
nothing at all — silently. It now overrides the storage, which is a real
provider token.
