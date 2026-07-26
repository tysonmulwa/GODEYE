# Deploying GODEYE to production

GODEYE is **not a single app** — it's a frontend, an API, a Python automation
engine, and supporting infrastructure. Vercel hosts the frontend; the rest need
a host that runs persistent processes. This guide covers the whole picture.

## The pieces and where they go

| Piece | What it is | Host |
|---|---|---|
| `apps/web` | Next.js frontend | **Vercel** |
| `apps/api` | NestJS API + Socket.IO (persistent server) | **Railway / Render / Fly.io** |
| `apps/engine` | FastAPI + Celery worker + Celery beat | **Railway / Render / Fly.io** |
| PostgreSQL | database | **Supabase** (already set up) |
| Redis | Celery broker + realtime pub/sub | **Upstash** (serverless Redis) |
| Object storage | generated images/videos | **Supabase Storage** or **Cloudflare R2** |

> Why not all-Vercel? Vercel runs the Next.js frontend and short-lived
> serverless functions. It cannot run the NestJS WebSocket server, the Celery
> worker, or the Beat scheduler — those are always-on processes. Put the web on
> Vercel and the two backend services on a container host. **Railway is the
> simplest** because one project can hold the API, the engine's three processes,
> and Redis together.

## Order of operations

Deploy the infrastructure first (DB, Redis, storage), then the API and engine,
then the web (it needs the API's public URL).

### 1. Secrets — generate fresh ones for production

Do **not** reuse the dev values in `.env`. Generate new ones:

```bash
# JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ENGINE_INTERNAL_SECRET
openssl rand -hex 32
# TOKEN_ENCRYPTION_KEY — must be exactly 32 bytes hex (64 chars)
openssl rand -hex 32
```

`TOKEN_ENCRYPTION_KEY` encrypts every stored platform credential — if you lose
or change it, all existing connections become undecryptable. Store it safely.

### 2. Database — Supabase (already done)

Use the same Supabase project, or create a dedicated production one. Apply
migrations against it:

```bash
DATABASE_URL="<prod pooler url>" pnpm --filter @godeye/db migrate:deploy
DATABASE_URL="<prod pooler url>" pnpm --filter @godeye/db seed   # seeds plans + a demo org
```

Use the **IPv4 session pooler** URL (`aws-0-<region>.pooler.supabase.com:5432`),
URL-encoding any special characters in the password.

### 3. Redis — Upstash

Create a database at upstash.com → copy the `rediss://` URL → this is `REDIS_URL`
for both the API and the engine.

### 4. Object storage — Supabase Storage or Cloudflare R2

Create a bucket and set `STORAGE_BACKEND=s3` plus `S3_ENDPOINT`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, and `S3_PUBLIC_URL` (the public base
for reading objects).

**`STORAGE_BACKEND` must be `s3` in production.** The `local` backend stores media
on the container's own filesystem — it disappears on every redeploy, isn't shared
between the API and the worker, and its URLs aren't reachable by the platforms.
Uploaded photos still publish to Facebook/Telegram (the engine uploads the bytes),
but **Instagram only accepts a public `image_url`**, so IG images require real
object storage with public read.

### 5. API — Railway (or Render/Fly)

The repo ships `apps/api/Dockerfile`. **The build context is the repo root** (the
pnpm workspace must be visible), so keep the service's root directory at the repo
root and point it at the Dockerfile — do **not** set root to `apps/api`.

- New service from the GitHub repo → set **Dockerfile path** `apps/api/Dockerfile`.
- Start command: none needed (the image runs `node dist/main.js`).
- **Env vars:** `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, all `JWT_*`,
  `TOKEN_ENCRYPTION_KEY`, `ENGINE_INTERNAL_SECRET`, `ENGINE_URL` (the engine's
  private URL), `WEB_URL` (**your Vercel domain** — drives CORS + the session
  cookie), the `S3_*` set, and any platform keys (`REDDIT_*`, `META_*`,
  `LINKEDIN_*`, `STRIPE_*`).
- `NODE_ENV=production` is required — it switches the refresh cookie to
  `SameSite=None; Secure` so login works across the Vercel↔API domain split.

### 6. Engine — one image, three services

`apps/engine/Dockerfile` (context = repo root, includes ffmpeg). Deploy it as
**three services sharing the same image**, overriding the start command on each:

```bash
# 1. api — receives enqueue calls from NestJS (this is the only one with a port)
uvicorn godeye_engine.api:app --host 0.0.0.0 --port $PORT   # image default
# 2. worker — runs the AI/publish jobs
celery -A godeye_engine.celery_app worker --loglevel=info
# 3. beat — fires due posts / autopilot every 30s
celery -A godeye_engine.celery_app beat --loglevel=info
```

All three need the same env: `DATABASE_URL`, `REDIS_URL`, `ENGINE_INTERNAL_SECRET`
(must match the API), an LLM key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`),
`GOOGLE_API_KEY` / image keys, and the `S3_*` set. Leave `FFMPEG_PATH` blank —
ffmpeg is on the image and found via PATH.

**Without the worker and beat services nothing publishes** — the API accepts the
schedule but no process ever dispatches it.

### 7. Web — Vercel

- Import the GitHub repo. **Root Directory: `apps/web`** (Vercel then installs
  the pnpm workspace from the repo root automatically; `@godeye/shared` is
  transpiled by Next, so no separate build step is needed). Framework and
  commands are pinned in `apps/web/vercel.json`.
- **Env var:** `NEXT_PUBLIC_API_URL` = your API's public URL (e.g.
  `https://godeye-api.up.railway.app`). It's read at build time, so redeploy
  after changing it.

### 8. Point the domains at each other

- API `WEB_URL` → the Vercel URL. Web `NEXT_PUBLIC_API_URL` → the API URL.
- Update every OAuth redirect URI to production and register it in each
  platform's app settings:
  - `REDDIT_REDIRECT_URI` = `https://<api>/connections/reddit/callback`
  - `META_REDIRECT_URI` = `https://<api>/connections/meta/callback`
  - `LINKEDIN_REDIRECT_URI` = `https://<api>/connections/linkedin/callback`
- If using Stripe, point its webhook at `https://<api>/webhooks/stripe` and set
  `STRIPE_WEBHOOK_SECRET`.

## Smoke test after deploy

1. Open the Vercel URL → register → you should land in onboarding (proves
   web → API → DB and the cross-site cookie all work).
2. Connections → Connect Reddit → completes OAuth and shows ACTIVE (proves the
   API OAuth flow and production redirect URIs).
3. Composer → Regenerate → returns copy (proves API → engine → Redis → LLM).
4. Schedule a post a few minutes out → it flips to PUBLISHED (proves Beat + the
   worker + the publisher).

If login fails with a session/cookie error, `NODE_ENV` isn't `production` on the
API, or `WEB_URL` doesn't exactly match the Vercel origin.
