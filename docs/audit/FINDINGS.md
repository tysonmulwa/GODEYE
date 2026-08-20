# Open findings

What is **not** fixed, and why. Kept separate from the scorecard so nothing has
to be inferred from a score that did not move.

Three categories: things a repository cannot do, things that need a human
decision, and things that are genuinely still to build.

---

## 🔴 Blocked on a human — required before this is finished

These are the reason Security is not scored 10/10.

### 1. ~~Rotate `JWT_ACCESS_SECRET`~~ — **DONE 2026-08-20**

Rotated on the Railway API service. Every OAuth `state` GODEYE had ever issued
was signed with this key, and those values sit in Meta's, TikTok's, LinkedIn's
and Reddit's logs, in browser history and in `Referer` headers — so each was a
live session credential. The code fix stopped new ones working as sessions;
only the rotation un-issued the old ones.

C-1 is now fully closed. **Runbook, for the next time:**
[KEY-MANAGEMENT.md](../security/KEY-MANAGEMENT.md).

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

Rewritten 2026-08-21. The previous version of this section described
Observability, Scalability and Accessibility as untouched, which stopped being
true and stayed on the page — a stale findings list is worse than none, because
it is read as current.

### Genuinely not built

| | Row | Why it matters |
|---|---|---|
| **E2E tests** | Testing | No Playwright. Nothing exercises sign-in → compose → schedule → publish as one flow, so an integration break between two green units is invisible until a customer hits it |
| **Mutation testing** | Testing | 1,513 tests and nothing measures whether they would notice a changed operator |
| **ADRs** | Code quality | Every decision in this branch is argued in a commit message or a code comment. Neither is where somebody looks in a year |
| **Complexity gate** | Code quality | No ceiling on function length or cyclomatic complexity |
| **CSP enforcement** | Security | The full policy is report-only. Enforcing it today blanks every page: measured — `pricing.html` has 14 unnonced inline scripts. Needs the app shell to render dynamically first ([CSP.md](../security/CSP.md)) |
| **E501** | Code quality | 37 prose comments exceed 100 characters. Not reflowed, because doing it beside a security fix makes both unreviewable |

### Built but never executed

The distinction matters more than it looks: configured is not executed, and a
green badge for a job that has never run is worse than no badge.

- **CodeQL and ZAP** — both wired into CI, neither has ever run. Actions is
  billing-locked.
- **`tests/load/publish-throughput.js`** — k6 exists, has never run. No staging,
  and 10× peak against production is not mine to do.
- **`alerts.yaml`** — 15 rules, never loaded into a Prometheus.
- **The OTel pipeline** — instrumented end to end, and **no trace has ever been
  exported**, because there is no collector to export to.
- **Migration down-paths** — written and reasoned for all four, executed for
  none.

### Covered by a mechanism, not yet by a measurement

- **Backups & DR** — the restore path now runs on every CI build against real
  Postgres and fails on one missing row. What has never happened is a restore
  of the **production** database, so RPO ≤ 5 min and RTO ≤ 2 h remain claims
  about a vendor's documentation. [DR.md](../operations/DR.md) has the hour-long
  procedure that closes it.
- **Accessibility** — the three gaps the audit named are fixed and pinned by 17
  tests. jsdom does not render, so contrast (1.4.3) is **Not Evaluated**, not
  Supports, and no screen reader has ever read the app aloud.
- **Two stores are backed up by nothing.** S3 media, and
  `TOKEN_ENCRYPTION_KEY` itself — which is not recoverable *from* a database
  backup, because it is what makes the backup readable. Losing it turns a
  restore into every customer reconnecting every social account at once.

### Infrastructure-layer egress filtering

The SSRF guard is application-layer only. Restricting the worker's outbound
network at the platform layer is defence in depth that a repository cannot add.

### `robots.txt` as a crawl permission

The crawler reads it for sitemap discovery but does not honour it as
permission. That is a legal point as much as a technical one.

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
