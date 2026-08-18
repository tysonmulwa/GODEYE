# GODEYE. Architecture

## System overview

```
                        ┌──────────────────────────────┐
                        │        Browser (user)        │
                        └──────┬───────────────▲───────┘
                               │ HTTPS         │ WebSocket (socket.io)
                     ┌─────────▼───────────────┴─────────┐
                     │        apps/web · Next.js         │
                     │  App Router · Tailwind · TanStack │
                     └─────────┬─────────────────────────┘
                               │ REST + cookies (refresh) / Bearer (access)
                     ┌─────────▼─────────────────────────┐
   Swagger /api/docs │        apps/api · NestJS          │
                     │ auth · orgs · profile · content   │
                     │ connections · scheduling · WS     │
                     └───┬───────────────┬───────────▲───┘
        internal HTTP    │               │ Prisma    │ Redis pub/sub
        X-Internal-Secret│               │           │ (godeye:events)
                     ┌───▼───────────────┼───────────┴───┐
                     │     apps/engine · Python          │
                     │ FastAPI (enqueue) · Celery worker │
                     │ Celery Beat (30s scheduler tick)  │
                     │ Content Agent · Publishers        │
                     └───┬───────────┬───────────────────┘
                         │           │
              ┌──────────▼──┐   ┌────▼─────────────────────────────┐
              │ PostgreSQL  │   │ Platform APIs: Telegram, Discord,│
              │ (Prisma-    │   │ Reddit, Meta Graph (FB+IG), ...  │
              │  owned)     │   └──────────────────────────────────┘
              └─────────────┘
              Redis: Celery broker/result + realtime pub/sub
              MinIO/S3: media assets (used from Phase 3)
```

## Key decisions (ADR summary)

1. **Hybrid backend.** NestJS owns the product API (auth, RBAC, billing later);
   Python owns automation (AI, scraping, publishing) where the ecosystem is strongest.
   Cross-service contract = internal HTTP (enqueue) + shared Postgres (state) +
   Redis pub/sub (events). No shared code between languages, the DB schema is the contract.

2. **Prisma is the single schema owner.** The Python engine maps the same tables with
   SQLAlchemy Core using Prisma's exact table/column names. Migrations only ever run
   through Prisma.

3. **Credentials encrypted at rest.** AES-256-GCM blob per connection
   (`iv.tag.ciphertext`, base64). The key never leaves `.env`. The engine decrypts just-in-time
   for publishing; credentials never appear in API responses or logs.

4. **Access/refresh token split.** 15-min JWT access token held in memory in the SPA;
   30-day rotating refresh token in an httpOnly cookie scoped to `/auth`. Refresh rotation
   revokes the presented token (theft detection surface).

5. **Publish pipeline is at-least-once with row locks.** Beat claims due posts with
   `FOR UPDATE SKIP LOCKED` + a `lockedAt` stamp (crash recovery after 5 min), sets
   PROCESSING, then workers publish. Transient failures retry (max 3, backoff);
   permanent platform rejections fail fast with the error stored on the row.

6. **Realtime is fire-and-forget.** Engine → Redis `godeye:events` → Nest gateway →
   socket.io room `org:{id}`. Missing an event only delays the UI (polling fallback exists).

## Request flow: "Generate with AI"

1. `POST /content/generate` (Nest) → creates `AgentRun(QUEUED)` → `POST engine:/tasks/generate-content`.
2. FastAPI enqueues the Celery task, returns `taskId`.
3. Worker: loads `BusinessProfile` → builds prompt → Anthropic (fallback OpenAI) →
   parses/enforces platform limits → inserts `ContentItem(DRAFT)` → updates `AgentRun(SUCCEEDED)`
   with tokens/cost → publishes `agent_run.completed`.
4. Browser (WS event or poll) fetches the content item → user edits → `POST /schedule`.
5. Beat tick claims the due `ScheduledPost` → publisher adapter posts → row updated
   (PUBLISHED + external id/url) → `scheduled_post.updated` → dashboard flips live.

## Autopilot & scheduling engine (Phase 2)

Beat runs four periodic tasks (`apps/engine/src/godeye_engine/celery_app.py`):

| Task | Interval | What it does |
|---|---|---|
| `dispatch_due_posts` | 30 s | claims due `ScheduledPost` rows, dispatches publishing |
| `plan_autopilot` | 5 min | for each active `PostingPlan` with `autoGenerate`, computes upcoming slots (preferred times, or engagement-driven best times) and queues `autopilot_generate` per slot |
| `collect_metrics` | hourly | pulls engagement for posts published in the last 7 days via each adapter's `get_metrics`, stores `AnalyticsSnapshot(metric="post_engagement")` |
| `recycle_evergreen` | 6 h | requeues proven evergreen content into quiet slots for opted-in plans |

**Best-time detection** (`intel.py`): averages `post_engagement` snapshots by local
publish hour over 90 days; falls back to per-platform heuristics until it has
≥8 data points. Empty `preferredTimes` on a plan opts into this.

**A/B testing**: with `abTest`, the Content Agent returns `abVariants.{A,B}` (two
distinct creative angles). Manual scheduling and the autopilot planner split A/B
across destinations by index (`variantKey`), the publisher picks the assigned
variant, and `GET /content/:id/ab-report` aggregates the latest engagement per
variant to name a winner.

**Publisher interface** now includes `get_metrics(credentials, external_post_id) -> float | None`
so every platform can feed the best-time and A/B engines. X uses OAuth 1.0a
(`publishers/oauth1.py`, RFC 5849 HMAC-SHA1); LinkedIn uses OAuth2 with a stored
token expiry.

## Image generation pipeline (Phase 3)

`POST /media/generate-image` (Nest) creates an `AgentRun(agent=IMAGE)` and calls
`engine:/tasks/generate-image`. The Celery `generate_image` task
(`apps/engine/src/godeye_engine/tasks/image.py`):

1. **Image Agent** (`ai/image_agent.py`) expands the brief into a detailed prompt
   via the text LLM (deterministic fallback if no text key).
2. **Image provider** (`ai/image_provider.py`) generates the pixels. OpenAI
   `gpt-image-1` (default) or Google Imagen, at the nearest supported size.
3. **Pillow** (`media/branding.py`) center-crops/resizes to the exact platform
   **preset** (`media/presets.py`, mirrors `packages/shared/image-presets.ts`) and
   optionally composites the org's **brand kit** logo + accent bar.
4. **Storage** (`storage.py`) uploads the PNG to MinIO/S3 (`boto3`); the public
   URL is stored on a `MediaAsset(kind=IMAGE, source=AI_GENERATED)`, linked to the
   content item.
5. A `media_asset.created` realtime event updates the composer live.

At publish time the scheduler loads `MediaAsset` URLs for the content item and
passes them to the publisher (`PostPayload.media_urls`), so Telegram (`sendPhoto`),
Discord (embeds), Facebook (`/photos`), and **Instagram** (which *requires* media)
post with the image. Autopilot plans with `generateImages` queue an image per post
automatically.

Brand logos are uploaded through the engine (`POST /storage/logo`) because the
engine owns the S3 credentials; the API never touches object storage directly.

## Short-video pipeline (Phase 4)

`POST /media/generate-video` → `AgentRun(agent=VIDEO)` → engine `generate_video` task
(`apps/engine/src/godeye_engine/tasks/video.py`):

1. **Video Agent** (`ai/video_agent.py`) writes a structured script: hook, 2–8
   scenes (narration + visual prompt + on-screen text), CTA, hashtags. Scene
   count and word budget scale with the target duration (~2.6 words/sec).
2. Per scene: **image provider** renders the visual; **OpenAI TTS**
   (`ai/tts_provider.py`) voices the narration; ffprobe measures the real audio
   duration (scene length = narration length).
3. **ffmpeg** (`media/video.py`) turns each scene into a motion clip (subtle
   Ken Burns zoom, 30 fps, H.264/AAC), concatenates them, and optionally burns
   phone-readable **SRT captions** (`media/subtitles.py`, cues split at ~42 chars
   and timed proportionally within each scene's audio).
4. The mp4 lands in MinIO/S3 as `MediaAsset(kind=VIDEO)` with duration, script
   metadata, and full cost accounting (LLM tokens + images + TTS characters).
5. Pipeline progress (`script → scenes → assembly → captions → upload`) is
   written to `AgentRun.output.progress`, so the UI shows live steps while polling.

Publishing: the scheduler passes video URLs separately (`PostPayload.video_urls`);
Telegram posts via `sendVideo`, Facebook via `/videos` (`file_url`), Discord by
appending the URL (auto-embed). IG Reels / X / YouTube uploads need chunked-upload
flows and arrive with those platforms' phases.

ffmpeg is located via `FFMPEG_PATH` or the system PATH; all ffmpeg invocations are
built by pure, unit-tested command builders. The task verifies ffmpeg exists
*before* spending money on generation.

## SEO engine (Phase 5)

`POST /seo/audit` → `SeoAudit` row + `AgentRun(agent=SEO)` → engine `run_site_audit`
task (`apps/engine/src/godeye_engine/tasks/seo.py`):

1. **Crawler** (`seo/crawler.py`), polite BFS over same-domain pages (0.5s delay,
   custom UA, max 20 pages): titles, metas, canonicals, headings, alt coverage,
   word counts, link graph, response times, OG/JSON-LD flags, plus robots.txt /
   sitemap.xml presence and broken-link detection.
2. **Rule engine** (`seo/audit.py`), ~16 checks across content, technical, and
   structured data; severities weight a 0-100 score with per-issue-type caps so
   one systemic problem can't zero the site.
3. **Generators** (`seo/generators.py`), a ready-to-publish `sitemap.xml` (noindex
   pages excluded) and `robots.txt`, downloadable from the audit.
4. **SEO Agent** (`ai/seo_agent.py`). LLM keyword clusters grouped by intent and
   meta title/description rewrites for weak pages; JSON-LD Organization/LocalBusiness
   markup is built deterministically from the business profile. AI extras are
   best-effort: without an LLM key the crawl, rules, score, and artifacts still work.

Results live on the `SeoAudit` row (findings, keywords, meta suggestions, schema,
artifacts); the SEO page polls while RUNNING and renders the score ring, grouped
findings, keyword chips, and copy-ready rewrites.

## Team, roles & approval workflows (Phase 6)

**RBAC.** The JWT already carries the caller's org role (OWNER > ADMIN > EDITOR > VIEWER).
`@MinRole(role)` + `RolesGuard` (`apps/api/src/common/roles.guard.ts`) enforce a floor per
route: VIEWER is read-only; EDITOR creates/edits/schedules content; ADMIN also manages the
team and reviews content. Grant/manage rules are strict-outrank: you can only assign roles
strictly below your own, and only touch members you outrank (OWNER is untouchable and
cannot leave their own org).

**Invitations.** `POST /members/invitations` (ADMIN+) creates an `Invitation` row storing
only the sha256 of a 32-byte token; the raw token appears once, inside the returned
`/invite/{token}` link (7-day expiry, single-use, reissue revokes prior pending invites for
the same email). The public accept endpoint either creates the account (new email; password
policy enforced) or verifies the existing account's password/MFA, then attaches a
`Membership` with the invited role. Multi-org users get `GET /auth/orgs` +
`POST /auth/switch-org` (fresh token pair scoped to the chosen org) and an org switcher in
the sidebar.

**Approval workflow.** `Organization.requireApproval` (Settings toggle, ADMIN+) gates
publishing:

- Manual flow: DRAFT → `POST /content/:id/submit` → PENDING_APPROVAL →
  `approve` (→ APPROVED, schedulable) or `reject` (→ DRAFT with a review note).
  `/schedule` refuses non-APPROVED content while the gate is on; the composer disables
  Schedule and shows submit/approve/reject controls, and the dashboard shows admins a
  review queue.
- Autopilot flow: the planner books the slots but writes the content as
  PENDING_APPROVAL; the dispatcher's claim query joins ContentItem + Organization and
  holds those posts until review. Approving releases them on the next 30s tick
  (past-due slots publish immediately); rejecting cancels the pending posts.
- Reviewer identity (`submittedBy`/`reviewedBy`, timestamps, note) is stored on the
  content item and audit-logged.

## Billing & plan limits (Phase 7)

**Plans** (`Plan` rows, seeded): FREE ($0, 30 posts/mo, 100K AI tokens, 3 channels,
1 seat), PRO ($49), SCALE ($199). An org's effective plan comes from its `Subscription`
(CANCELED or missing → FREE).

**Metering** (`BillingService.usage`, computed live, no counters to drift):
posts = `ScheduledPost` rows created this calendar month; AI tokens = sum of
`AgentRun` input+output tokens this month; channels = non-disconnected
`SocialConnection`s; seats = memberships + pending invitations.

**Enforcement**, `assertWithinLimit(orgId, metric)` throws 403 with an upgrade hint from
four choke points: scheduling (`/schedule`, counts one per destination), content
generation (blocks once the monthly token budget is spent), connection creation (new
connections only), and member invites. The engine's autopilot is intentionally not
gated per-slot (plans are already limited by cadence).

**The 24-hour trial**, registration creates a `TRIALING` subscription on the Pro plan
with `currentPeriodEnd` 24 hours out (`WorkspaceAccessService.startTrial`). Two things
act on it: `state()` *computes* the answer from that timestamp, so a trial that ran out a
second ago is already locked, and `sweep()` (every 15 minutes) *records* it, flipping
expired trials to `PAST_DUE` and backfilling a subscription for any workspace that has
none. `TrialLockInterceptor` is registered globally (`APP_INTERCEPTOR`) and refuses every
mutating request from a locked workspace except `/auth`, `/billing`, `/webhooks` and
`/health`, reading stays open, so nothing is lost, only paused. The workspaces GODEYE
itself runs (`BILLING_EXEMPT_SLUGS`: godeye, patampoa, mjini-collection) are never billed
and never locked.

**Two ways to pay, because Paystack can only re-charge a card.** A card is a real
Paystack subscription (`plan` code) that renews itself monthly. Apple Pay and M-Pesa
produce authorisations Paystack cannot charge again, so they buy one month at a time:
`POST /billing/checkout {mode: "once"}` initializes a plain transaction with
`channels` and no plan, priced in KES from the shared catalogue (M-Pesa settles in
shillings and a transaction carries one currency). `charge.success` with
`metadata.mode === "once"` sets `currentPeriodEnd` a month past whichever is later,
now, or the end already paid for, and leaves `providerSubscriptionId` null. That null
is load-bearing: it is how the guard, the sweeper and the engine tell a month that ends
from a card that renews. A bought month locks the workspace the instant it runs out; a
card subscription past its renewal date is left alone, because Paystack retries a failed
charge and its webhook is what cancels, locking a paying customer over a slow webhook
is the worse of the two errors.

**Paystack**, the only payment provider. When `PAYSTACK_SECRET_KEY` and the
`PAYSTACK_PLAN_*` codes are set, `POST /billing/checkout` initializes a transaction
against the plan (plain HTTPS calls, no SDK dependency) carrying `orgId` in metadata,
which is the only link back to the workspace when the webhook arrives with no session.
`POST /webhooks/paystack` (HMAC SHA512 over the raw body, keyed by the secret key,
timing-safe) activates the subscription on `charge.success` / `subscription.create` and
cancels on `subscription.disable`. Without the keys, metering and the trial still work;
the upgrade buttons hide rather than opening a checkout that cannot start.

## Repository layout

See [README](../README.md#monorepo-layout). Conventions:

- **apps/api**: one Nest module per domain; zod schemas from `@godeye/shared` validate
  every input via `ZodPipe`; all org-scoped queries filter by `orgId` from the JWT.
- **apps/engine**: `ai/` (agents), `publishers/` (one adapter per platform, common base
  with retry), `tasks/` (Celery). New platforms = new adapter + registry entry.
- **packages/shared**: platform registry + zod schemas + API DTO types, consumed by web and api.

## Security model (current phase)

- argon2id password hashing; TOTP MFA (optional per user)
- Global rate limit 100 req/min; 10/min on auth and connection endpoints
- helmet, strict CORS (web origin only), cookie `SameSite=Lax`
- Meta webhooks HMAC-verified (`X-Hub-Signature-256`, timing-safe compare)
- Audit log on auth, connection, scheduling and profile events
- Engine API requires `X-Internal-Secret`; never exposed publicly

## Scaling path (later phases)

- API and engine are stateless → horizontal scale behind a load balancer / K8s HPA
- Celery: switch `--pool=solo` (Windows dev) to prefork/gevent workers per queue
  (`content`, `publish`, `seo`, `media`) with per-queue autoscaling
- Postgres: RDS + read replicas; analytics snapshots → partitioned tables
- Redis: managed (ElastiCache), separate DBs for broker vs pub/sub
- Media: MinIO → S3 + CloudFront
