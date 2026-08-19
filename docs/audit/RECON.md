# RECON — P0 findings located at HEAD

**Branch:** `security/p0-remediation`
**HEAD:** `21b6733` ("Draw the M-PESA mark the way the wordmark is drawn")
**Date:** 2026-08-19
**Working tree:** clean at time of recon. **No source file has been modified.**

Every location below was re-derived by grep at this commit. The audit's line numbers were
**not** trusted; where they drifted, the current line is given and the drift noted.

---

## 0. Baseline

### 0.1 Test suites

| Suite | Command | Result | Duration |
|---|---|---|---|
| API | `npx jest` (in `apps/api`) | **199 passed**, 17 suites, 0 failed | 106.485 s cold / 49.541 s warm |
| Engine | `python -m pytest -q` (in `apps/engine`) | **653 passed**, 0 failed | 40.40 s (45.67 s with coverage) |
| **Total** | | **852 passed** | |

Audit baseline was 199 + 653 = 852. **Counts match exactly. The audit is not stale.**

API suite requires `TOKEN_ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` in the
environment (same values CI uses).

### 0.2 Coverage — captured before any change

Artifacts: `docs/audit/baseline-coverage-api.json`, `docs/audit/baseline-coverage-engine.json`.
(Note: `.gitignore` contains a bare `coverage/` rule, so coverage output must not be written
to a directory named `coverage` or it is silently untracked.)

**API (Jest, istanbul):**

| Metric | Covered / Total | % |
|---|---|---|
| Statements | 968 / 1553 | 62.33% |
| Branches | 413 / 777 | 53.15% |
| Functions | 126 / 287 | 43.90% |
| Lines | 881 / 1394 | 63.19% |

**Engine (pytest-cov):** 4355 statements, 1313 missed — **70%**. 15 files at 100%.
Zero-coverage engine modules: `tasks/content.py`, `tasks/diagnostics.py`, `tasks/metrics.py`,
`tasks/video.py` (all 0%); `tasks/seo.py` 21%, `tasks/product_posts.py` 28%.

`pytest-cov` was not previously a dev dependency. It has been added to the `dev` extra in
`apps/engine/pyproject.toml` so this baseline is reproducible by CI and by anyone else — a
number nobody else can regenerate is not evidence. Dev-tooling only; no runtime dependency
and no behaviour changed.

### 0.3 The coverage finding that explains everything

Jest instruments only files a test actually loads. **22 of 45 non-spec source files in
`apps/api/src` appear in the coverage map. The other 23 are never loaded by any test.**

The 23 never-loaded files:

```
app.module.ts                            media/media.controller.ts
auth/auth.controller.ts                  media/media.module.ts
auth/auth.module.ts                      members/members.controller.ts
business-profile/business-profile.module.ts   members/members.module.ts
common/common.module.ts                  realtime/realtime.gateway.ts
common/site-verification.controller.ts   realtime/realtime.module.ts
connections/connections.controller.ts    scheduling/scheduling.controller.ts
connections/connections.module.ts        scheduling/scheduling.module.ts
content/content.controller.ts            webhooks/webhooks.controller.ts
content/content.module.ts                webhooks/webhooks.module.ts
engine/engine.module.ts                  main.ts
health.controller.ts
```

**Every controller in the API is at 0% coverage.** `@UseGuards`, `@MinRole` and `@Throttle`
are decorators *on controllers*. Therefore **no test in the 852 has ever executed a guard
chain.** That is the mechanical reason C-1 and S-1 survived a green suite.

The point is sharpest here:

| File | Statements | Branches |
|---|---|---|
| `common/roles.guard.ts` | **100%** | **100%** |
| `common/jwt-auth.guard.ts` | 40% | **0%** |
| `connections/connections.service.ts` | 27.5% | 28% |
| `engine/engine.service.ts` | 12.5% | 0% |
| `connections/connections.controller.ts` | *(never loaded)* | *(never loaded)* |

`RolesGuard` is at 100% statement and 100% branch coverage — and S-1 is that it is **not
wired into five controllers**. A perfectly covered unit inside a broken system. Mocked
wiring is not verified wiring.

---

## 1. Findings

### C-1 — OAuth state JWTs signed with `env.jwtAccessSecret()` and accepted by `JwtAuthGuard`

**STATUS: CONFIRMED**

Signing sites — five OAuth2 flows, all using the session access-token secret:

| Flow | `signAsync` | secret | `verifyAsync` |
|---|---|---|---|
| reddit | `connections.service.ts:235` | `:237` | `:243` / `:245` |
| linkedin | `connections.service.ts:275` | `:277` | `:283` / `:285` |
| tiktok | `connections.service.ts:303` | `:305` | `:311` / `:313` |
| instagram | `connections.service.ts:340` | `:342` | `:348` / `:350` |
| meta | `connections.service.ts:374` | `:376` | `:383` / `:385` |

The only other `signAsync` in the codebase is the real access token at
`apps/api/src/auth/auth.service.ts:499-500` — **same secret, `env.jwtAccessSecret()`**.

Acceptance site: `apps/api/src/common/jwt-auth.guard.ts:27-28` verifies signature and expiry
only. No `purpose`, `typ`, `iss` or `aud` check.

Escalation target: `apps/api/src/auth/auth.controller.ts:192-206` — `POST /auth/switch-org`
carries `@UseGuards(JwtAuthGuard)` at line **194** and **no `@MinRole`**. `RolesGuard`
short-circuits on absent metadata (`roles.guard.ts:42`, `if (!required) return true`), so a
state token reaches the handler, and `AuthService.switchOrg` issues a full session
(access token + 30-day refresh cookie).

A third acceptance site shares the secret: `realtime.gateway.ts:36-37`.

*Audit drift:* none. All five audit line numbers exact.

---

### S-1 — `RolesGuard` missing on connections / media / seo / products / business-profile

**STATUS: CONFIRMED (5 of 5)**

Complete guard-chain inventory at HEAD:

| Controller | Declaration | Chain | `@MinRole` used |
|---|---|---|---|
| `auth.controller.ts:66` | `@Controller("auth")` | **per-method `JwtAuthGuard` only** (9 sites: 114,121,133,153,185,194,208,216,227) | none |
| `billing.module.ts:633` | `@Controller("billing")` | `JwtAuthGuard, RolesGuard` (:634) | ADMIN ×2 |
| `content.controller.ts:40` | `@Controller("content")` | `JwtAuthGuard, RolesGuard` (:41) | EDITOR ×4, ADMIN ×2 |
| `members.controller.ts:19` | `@Controller("members")` | `JwtAuthGuard, RolesGuard` (:20) | ADMIN ×4 |
| `scheduling.controller.ts:28` | `@Controller()` | `JwtAuthGuard, RolesGuard` (:29) | EDITOR ×6 |
| **`connections.controller.ts:31`** | `@Controller("connections")` | **`JwtAuthGuard` only** (11 sites: 38,45,52,64,76,107,140,155,186,221,258) | **none** |
| **`media.controller.ts:36`** | `@Controller("media")` | **`JwtAuthGuard` only** (:37) | **none** |
| **`seo.module.ts:409`** | `@Controller("seo")` | **`JwtAuthGuard` only** (:410) | **none** |
| **`products.module.ts:197`** | `@Controller("products")` | **`JwtAuthGuard` only** (:198) | **none** |
| **`business-profile.module.ts:64`** | `@Controller("business-profile")` | **`JwtAuthGuard` only** (:65) | **none** |
| `webhooks.controller.ts:20` | `@Controller("webhooks")` | none (by design, HMAC) | n/a |
| `health.controller.ts:19` | `@Controller("health")` | none (by design) | n/a |
| `site-verification.controller.ts:16` | `@Controller()` | none (by design) | n/a |

Because `RolesGuard` is absent from the chain on those five, adding `@MinRole` to any of
their routes today would be a **silent no-op**.

Unprotected write routes on `media.controller.ts`: `POST generate-image` (:42),
`POST generate-video` (:52), `POST upload` (:62), `POST :id/attach` (:77),
`DELETE :id` (:86), `PUT brand-kit` (:98), `POST brand-kit/logo` (:106),
`POST brand-kit/music` (:116), `DELETE brand-kit/music` (:128).

*Audit drift:* none.

---

### S-2 — SSRF via the SEO crawler

**STATUS: CONFIRMED**

Entry: `POST /seo/audit` — `apps/api/src/seo/seo.module.ts:415` (route), handler
`SeoService.runAudit` at `:61`.

URL selection `:66` — `const url = input.url ?? profile?.website ?? undefined;`
Ownership gate `:77-80`:

```ts
const ownedHost  = hostOf(profile?.website);          // :77
const requestedHost = hostOf(url);                     // :78
const isForeign = !!ownedHost && !!requestedHost && ownedHost !== requestedHost;  // :79
if (isForeign && !input.allowForeign) { throw new ConflictException(...) }        // :80
```

Two bypasses, both from the source: `ownedHost === null` (no website on the profile) makes
`isForeign` false; and `allowForeign: true` is an ordinary schema field
(`packages/shared/src/schemas.ts:223`).

Egress: `apps/engine/src/godeye_engine/seo/crawler.py` builds three `httpx.Client`s, all
with `follow_redirects=True`:
- `:247-248` (`fetch_pages`)
- `:278-279` (`fetch_text`)
- `:298-301` (`crawl`)

**Egress filter: none.** `grep -rniE "ipaddress|is_private|169\.254|link.?local|ssrf"` over
`apps/engine/src` returns exactly one hit — `publishers/tiktok.py:343 "is_private_account"`,
a TikTok privacy-level field, unrelated. No `ipaddress` import anywhere in the engine.

Route carries no `RolesGuard` (S-1), so a VIEWER can reach it.

*Audit drift:* audit cited `seo.module.ts:57-80`; `runAudit` actually begins at `:61`.

---

### S-3 — SSRF via product import

**STATUS: CONFIRMED**

Entry: `POST /products/import` — `apps/api/src/products/products.module.ts:218` (route),
handler `ProductsService.importNow` at `:109`.

Gate is consent-only, never URL validation (`:113-121`): rejects when
`profile.productImportConsentAt` is null, and when neither `input.url` nor `profile.website`
is set. `input.url` itself is passed through unvalidated to
`this.engine.enqueueImportProducts({ orgId, url: input.url, limit })` at `:124`.

Consent is self-granted via `PUT /products/settings` (`products.module.ts:209`,
`productSettingsSchema` at `packages/shared/src/schemas.ts:246`) — and that route also has
no `RolesGuard`.

Worker side: `apps/engine/src/godeye_engine/tasks/products.py:86`
`target = url or profile["website"]` → `sources.import_from_site(target, limit=limit)` at
`:94`. Client: `apps/engine/src/godeye_engine/products/sources.py:75` —
`httpx.Client(headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)`. No egress filter.

*Audit drift:* none.

---

### S-4 — No `app.set("trust proxy", ...)` anywhere

**STATUS: CONFIRMED — zero hits, as predicted**

```
$ grep -rn "trust proxy|trustProxy|set(\"trust" apps/api apps/web packages
(no output, exit 1)
```

`ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])` — `app.module.ts:24`.
`ThrottlerGuard` registered globally — `app.module.ts:42`.
`main.ts` calls `enableCors`, `useBodyParser` ×2, `helmet()`, `cookieParser()`,
`enableShutdownHooks()`, `listen()` — and never `app.set(...)` of any kind.

26 `@Throttle` overrides exist across 8 files (auth ×8, billing ×2, connections ×4,
content ×1, media ×5, members ×1, products ×1, seo ×3). All 26 currently share one bucket
keyed on the Railway edge address.

`req.ip` is also recorded into the audit trail at `auth.controller.ts:241`, so every stored
IP is the proxy's.

*Audit drift:* none.

---

### S-5 — `ENGINE_INTERNAL_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` have public defaults

**STATUS: CONFIRMED**

| Location | Code |
|---|---|
| `apps/api/src/common/env.ts:96` | `engineInternalSecret: process.env.ENGINE_INTERNAL_SECRET ?? "dev-engine-secret"` |
| `apps/api/src/common/env.ts:206` | `webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "godeye-verify"` |
| `apps/engine/src/godeye_engine/config.py:32` | `engine_internal_secret: str = "dev-engine-secret"` |

Both sides of the internal channel default to the **same repository-published string**.

Consumers: `apps/api/src/engine/engine.service.ts:175` sends the header;
`apps/engine/src/godeye_engine/api.py:18` checks it with `!=` (not `hmac.compare_digest`);
`apps/api/src/webhooks/webhooks.controller.ts:33` compares the Meta verify token with `===`.

No startup assertion anywhere rejects the default value.

*Audit drift:* none.

---

### S-6 — `.env.example` ships a format-valid all-zeros `TOKEN_ENCRYPTION_KEY`

**STATUS: CONFIRMED, and worse than described**

`.env.example:29` — `TOKEN_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000`
`apps/engine/src/godeye_engine/config.py:33` — `token_encryption_key: str = "0" * 64`

Validation is format-only and the zeros pass both:
- `apps/api/src/common/crypto.service.ts:13` — `/^[0-9a-fA-F]{64}$/`
- `apps/engine/src/godeye_engine/security.py:20` — `len(key) != 32` after `bytes.fromhex`

`env.ts:95` requires the variable to be *present*, never that it be strong. The engine does
not even require presence — it defaults.

**Additional, not in the audit:** `apps/engine/src/godeye_engine/seo/indexnow.py:52` derives
the public IndexNow key from `TOKEN_ENCRYPTION_KEY`. That key is **published on the
customer's own website** as a key file. This is key reuse across a confidentiality boundary:
the same secret both encrypts platform credentials at rest and seeds a public value. Recorded
here as a new finding (proposed id **S-6b**) for the fix phase.

*Audit drift:* none on S-6 itself.

---

### S-7 — Meta webhook persists rows with an invalid signature; `timingSafeEqual` can throw

**STATUS: CONFIRMED (both halves)**

`apps/api/src/webhooks/webhooks.controller.ts:40-58` — `receiveMeta`:

```ts
const valid = this.validSignature(raw, signature);            // :47
if (!valid) this.logger.warn("... stored for review");        // :48
await this.prisma.webhookEvent.create({ ... });               // :50  ← unconditional
return { received: true };                                    // :57  ← always 200
```

The write at `:50` is not guarded by `valid`. Unauthenticated, and `/webhooks` is on the
trial-lock open-list (`trial-lock.interceptor.ts:24`), so a locked workspace does not stop it.
Body limit is 30 MB (`main.ts:59`).

Throw path — `:60-65`:

```ts
if (expected.length !== provided.length) return false;                       // :64 hex-string lengths
return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));  // :65 decoded buffers
```

A 64-char non-hex `provided` passes the `:64` length check, then `Buffer.from(x,"hex")`
truncates at the first invalid pair, producing buffers of unequal length, and
`timingSafeEqual` throws `RangeError` → 500.

Contrast `apps/api/src/billing/billing.module.ts:585-591`, which compares the **raw strings**
and is correct. The two verifiers should share one implementation.

*Audit drift:* none.

---

### S-8 — Payment idempotency read-then-write race in `applyPayment`

**STATUS: CONFIRMED**

`apps/api/src/billing/billing.module.ts`, marker constant at `:86`
(`const PAYMENT_APPLIED = "billing.payment_applied"`):

| Line | Code |
|---|---|
| `:497-498` | `const alreadyDone = await this.prisma.auditLog.findFirst({ where: { action: PAYMENT_APPLIED, targetId: reference }, ... })` |
| `:501` | `if (alreadyDone) return false;` |
| `:541` | `await this.prisma.subscription.upsert({ ... })` |
| `:554` | `action: PAYMENT_APPLIED` (the marker insert) |
| `:565` | `.catch(() => undefined)` |

Three defects in one path: read-then-write with no transaction and no unique constraint
(the `AuditLog` table has none — see D-1); a window between the subscription upsert at `:541`
and the marker insert completing, during which a second caller reads the already-extended
`currentPeriodEnd` and adds another month; and `:565` swallowing the failure of the very row
that is the idempotency record.

`:565` is the **only** `catch(() => undefined)` in `apps/api/src`. Confirmed by grep — no
other swallowed-error sites in the API, and `grep -rn "except:" apps/engine/src` returns
zero bare excepts.

Both callers reach it: webhook `handlePaystackEvent` (`:601`) and browser
`verifyPayment` (`:465`).

*Audit drift:* none.

---

### S-9 — Swagger UI served unconditionally in production

**STATUS: CONFIRMED**

`apps/api/src/main.ts:66` builds the document, `:72` mounts it:

```ts
SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));
```

No `env.nodeEnv` guard, no auth. `@nestjs/swagger` is a production dependency
(`apps/api/package.json`). `main.ts` is one of the 23 never-loaded files, so nothing asserts
this either way.

*Audit drift:* none.

---

### S-10 — Role/membership changes don't take effect until the access token expires

**STATUS: CONFIRMED**

Authorization reads the role from the token, never from the database:
- `apps/api/src/common/roles.guard.ts:45` — `if (!auth || !roleAtLeast(auth.role, required))`
- `apps/api/src/auth/auth.service.ts:190` — `me()` returns `role: auth.role`

`grep -rn "sessionVersion" apps/api/src` → **zero hits**. No token-version or revocation
check of any kind on the access path.

Mutation sites that do **not** revoke sessions:
- `apps/api/src/members/members.service.ts:146-149` — `changeRole` updates `Membership` only
- `apps/api/src/members/members.service.ts:176` — `remove` deletes `Membership` only

`RefreshToken.revokedAt` is written in four places (`auth.service.ts:160,172,255`,
`members.service.ts:84,125` — the latter two are `Invitation.revokedAt`, a different model).
**None is reached from `changeRole` or `remove`.** Access token TTL is 15 minutes
(`auth.service.ts:29`, `ACCESS_TOKEN_TTL = "15m"`).

*Audit drift:* none.

---

### S-11 — OAuth state not bound to the completing browser

**STATUS: CONFIRMED (5 of 6 flows)**

The X flow (OAuth 1.0a) is the counter-example and does it correctly:
`connections.service.ts:191-196` stores `x_oauth:<token>` in Redis with a 30-minute TTL;
`:201` reads it; `:208` deletes it — single use, server-side.

The five OAuth2 flows (reddit, linkedin, tiktok, instagram, meta) use a **stateless JWT**
with no server-side record and no cookie binding. Grepping `connections.service.ts` for
`nonce` or `cookie` returns **zero hits**. Nothing ties the `state` presented at the callback
to the browser that began the flow, and nothing prevents replay within the 30-minute
`OAUTH_STATE_TTL` (`connections.service.ts:42`).

*Audit drift:* none.

---

### B-4 — Zero `AbortSignal` / timeouts on outbound `fetch()`

**STATUS: CONFIRMED — exactly 11 call sites, exactly 0 timeouts**

```
$ grep -rn "AbortSignal|signal:|AbortController" apps/api/src --include=*.ts
(no output, exit 1)
```

The 11 sites:

| # | Location | Target |
|---|---|---|
| 1 | `billing/billing.module.ts:247` | `api.paystack.co/plan/:code` |
| 2 | `billing/billing.module.ts:308` | `api.paystack.co/transaction/initialize` |
| 3 | `billing/billing.module.ts:437` | `api.paystack.co/transaction/verify/:ref` |
| 4 | `connections/platform-clients.ts:14` | generic helper (all platform calls funnel here) |
| 5 | `connections/platform-clients.ts:129` | reddit token |
| 6 | `connections/platform-clients.ts:186` | linkedin token |
| 7 | `connections/platform-clients.ts:306` | tiktok token |
| 8 | `connections/platform-clients.ts:372` | instagram token |
| 9 | `connections/platform-clients.ts:543` | X (OAuth1) |
| 10 | `connections/platform-clients.ts:600` | X (OAuth1) |
| 11 | `engine/engine.service.ts:182` | the engine, **all** enqueue + storage + health calls |

Site 11 is reached by `HealthController.health` (`health.controller.ts:56`), so `/health`
can itself hang.

**Scope correction to the audit:** the Python side is *not* affected. Every engine `httpx`
call either sets an explicit timeout or inherits httpx's 5 s default — `publishers/base.py:30`
(30 s), `:191`, `seo/crawler.py` `TIMEOUT = 15.0`, `seo/indexnow.py:108`,
`products/sources.py:75`, `products/supabase_store.py:120`. B-4 is a Node-only finding.

*Audit drift:* none ("~11" is exactly 11).

---

### B-7 — `SocialConnection.expiresAt` written in 4 places, read in 0; no refresh task

**STATUS: CONFIRMED**

Written (the four OAuth callbacks compute it):
`connections.service.ts:262` (reddit), `:295` (linkedin), `:327` (tiktok), `:366` (instagram).
Declared `:432`, persisted `:451` (update) and `:463` (create).
Schema: `packages/db/prisma/schema.prisma:201` — `expiresAt DateTime?`.

**Read: zero.** Every other `expiresAt` hit in the repo belongs to a different model —
`RefreshToken` (`auth.service.ts:154,509`; `schema.prisma:118`), `Invitation`
(`auth.service.ts:418`; `members.service.ts:37,55,78,93,111`; `billing.module.ts:163`;
`schema.prisma:102`), or the in-memory access cache (`workspace-access.service.ts:30,137,167`).
No query anywhere filters or compares `SocialConnection.expiresAt`.

Beat schedule (`apps/engine/src/godeye_engine/celery_app.py:50-83`) has 8 entries:
`dispatch-due-posts`, `plan-autopilot`, `collect-metrics`, `reap-stale-runs`,
`scheduled-product-imports`, `plan-product-posts`, `reap-stuck-posts`, `recycle-evergreen`.
**No token-refresh task.**

Only lazy refresh in the codebase: `publishers/reddit.py:17-27`, at publish time, Reddit only.
Nothing sets `ConnectionStatus.EXPIRED` proactively.

*Audit drift:* none.

---

### D-1 — `AuditLog` has no index on `(action, targetId)`

**STATUS: CONFIRMED**

`packages/db/prisma/schema.prisma:707-723`. The model declares exactly one index:

```prisma
@@index([orgId, createdAt])
```

`action` (`:711`) and `targetId` (`:713`) are unindexed, and there is no `@@unique`.
`grep -rn "AuditLog" packages/db/prisma/migrations/*/migration.sql | grep -i "index|unique"`
returns **zero** — no migration has ever added one.

The query at `billing.module.ts:497-498` filters on exactly `(action, targetId)`, so the
payment idempotency check is a sequential scan of the highest-write table in the schema.
No retention job exists for `AuditLog`.

*Audit drift:* none.

---

## 2. Nothing was "NOT FOUND"

All 15 findings are present and reproducible at `21b6733`. Two required a correction to the
audit's *scope* rather than its existence (S-2 line offset, B-4 Python false-positive), noted
inline.

---

## 3. New findings surfaced during recon (not in the audit)

Recorded, not fixed. Proposed ids continue the audit's scheme.

| id | Finding | Location | Note |
|---|---|---|---|
| **S-6b** | `TOKEN_ENCRYPTION_KEY` is reused to derive the **public** IndexNow key, which is published as a file on the customer's website | `apps/engine/src/godeye_engine/seo/indexnow.py:52` | Key reuse across a confidentiality boundary. HMAC output, so not directly invertible, but the credential-encryption key must not seed public values. |
| **S-20** | `download_media(url)` fetches an arbitrary URL with `follow_redirects=True` and no egress filter — a **third** SSRF sink the audit did not list | `apps/engine/src/godeye_engine/publishers/base.py:21-30`; callers `base.py:70,77`, `meta.py:48,182`, `telegram.py:32,82`, `tiktok.py:108` | Reachable via `MediaAsset.url` and `BrandKit.musicUrl`. Needs the same egress guard as S-2/S-3; must be in scope for that fix. |
| **INFO** | `dump.rdb` (3.4 MB Redis dump, 1541 Celery task results) is tracked and still present at HEAD | introduced in `573d097`, `ab545ac` | Scanned: no credentials. Repo hygiene; history rewrite needed to fully remove. |
| **INFO** | `.gitignore` has a bare `coverage/` rule that silently swallows any path containing a `coverage` directory | `.gitignore` | Cost one lost coverage artifact during this recon. |

---

## 4. Commands used

```bash
grep -rn "jwtAccessSecret|signAsync|verifyAsync" apps/api/src --include=*.ts
grep -rn "@Controller|@UseGuards|@MinRole" apps/api/src --include=*.ts
grep -rn "trust proxy|trustProxy|set(\"trust" apps/api apps/web packages   # zero hits
grep -rn "fetch(" apps/api/src --include=*.ts
grep -rn "AbortSignal|signal:|AbortController" apps/api/src --include=*.ts # zero hits
grep -rn "follow_redirects" apps/engine/src
grep -rniE "ipaddress|is_private|169\.254|link.?local|ssrf" apps/engine/src
grep -rn "expiresAt" apps/api/src apps/engine/src packages/db/prisma
grep -rn "catch(() => undefined)" apps/api/src ; grep -rn "except:" apps/engine/src
grep -rn "sessionVersion" apps/api/src                                     # zero hits
git log --all --oneline -- dump.rdb
```

Note: run greps scoped to `apps/*/src`. A repo-root `grep -r --include=*.py .` walks
`.venv` and `node_modules` and exceeds a 120 s timeout.
