# Deploying GODEYE to production

GODEYE is **not a single app**, it's a frontend, an API, a Python automation
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
> worker, or the Beat scheduler, those are always-on processes. Put the web on
> Vercel and the two backend services on a container host. **Railway is the
> simplest** because one project can hold the API, the engine's three processes,
> and Redis together.

## Order of operations

Deploy the infrastructure first (DB, Redis, storage), then the API and engine,
then the web (it needs the API's public URL).

### 1. Secrets, generate fresh ones for production

Do **not** reuse the dev values in `.env`. Generate new ones:

```bash
# JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ENGINE_INTERNAL_SECRET
openssl rand -hex 32
# TOKEN_ENCRYPTION_KEY, must be exactly 32 bytes hex (64 chars)
openssl rand -hex 32
```

`TOKEN_ENCRYPTION_KEY` encrypts every stored platform credential, if you lose
or change it, all existing connections become undecryptable. Store it safely.

### 2. Database. Supabase (already done)

Use the same Supabase project, or create a dedicated production one. Apply
migrations against it:

```bash
DATABASE_URL="<prod pooler url>" pnpm --filter @godeye/db migrate:deploy
DATABASE_URL="<prod pooler url>" pnpm --filter @godeye/db seed   # seeds plans + a demo org
```

Use the **IPv4 session pooler** URL (`aws-0-<region>.pooler.supabase.com:5432`),
URL-encoding any special characters in the password.

### 3. Redis. Upstash

Create a database at upstash.com → copy the `rediss://` URL → this is `REDIS_URL`
for both the API and the engine.

### 4. Object storage. Supabase Storage or Cloudflare R2

Create a bucket and set `STORAGE_BACKEND=s3` plus `S3_ENDPOINT`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, and `S3_PUBLIC_URL` (the public base
for reading objects).

**`STORAGE_BACKEND` must be `s3` in production.** The `local` backend stores media
on the container's own filesystem, it disappears on every redeploy, isn't shared
between the API and the worker, and its URLs aren't reachable by the platforms.
Uploaded photos still publish to Facebook/Telegram (the engine uploads the bytes),
but **Instagram only accepts a public `image_url`**, so IG images require real
object storage with public read.

### 5. API on Railway (or Render/Fly)

The repo ships `apps/api/Dockerfile`. **The build context is the repo root** (the
pnpm workspace must be visible), so keep the service's root directory at the repo
root and point it at the Dockerfile, do **not** set root to `apps/api`.

- New service from the GitHub repo → set **Dockerfile path** `apps/api/Dockerfile`.
- Start command: none needed (the image runs `node dist/main.js`).
- **Env vars:** `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, all `JWT_*`,
  `TOKEN_ENCRYPTION_KEY`, `ENGINE_INTERNAL_SECRET`, `ENGINE_URL` (the engine's
  private URL), `WEB_URL` (**your Vercel domain**, drives CORS + the session
  cookie), the `S3_*` set, and any platform keys (`REDDIT_*`, `META_*`,
  `LINKEDIN_*`, `PAYSTACK_*`).
- `NODE_ENV=production` is required, it switches the refresh cookie to
  `SameSite=None; Secure` so login works across the Vercel↔API domain split.

### Which image runs which command

Two images, and their start commands are **not interchangeable**:

| Service | Image | Start command |
|---|---|---|
| `GODEYE` (API) | `apps/api/Dockerfile` — **Node** | `node dist/main.js` |
| engine api | `apps/engine/Dockerfile` — **Python** | `uvicorn godeye_engine.api:app --host 0.0.0.0 --port $PORT` |
| engine worker | `apps/engine/Dockerfile` — **Python** | `celery -A godeye_engine.celery_app worker --beat --schedule=/tmp/celerybeat-schedule --loglevel=info --concurrency=2 --max-tasks-per-child=50` |

A Celery command on the API service fails with **"The executable `celery` could
not be found"**: the Node image has no Python in it. This is worth stating
because the failure is quiet in the worst way — the new container never starts,
so Railway keeps the **previous** one serving and retries. The dashboard shows
"building" indefinitely while the old build answers requests, which reads like a
slow build rather than a broken command.

If a service will not start, check its **custom start command** before anything
else. A value set in the Railway dashboard overrides both `railway.json` and the
Dockerfile's `CMD`. Clearing it is usually the fix, because each image already
knows how to run itself.

### 6. Engine, one image, two services

`apps/engine/Dockerfile` (context = repo root, includes ffmpeg). Deploy it as
**two services sharing the same image**, overriding the start command on each:

```bash
# 1. api, receives enqueue calls from NestJS (this is the only one with a port)
uvicorn godeye_engine.api:app --host 0.0.0.0 --port $PORT   # image default
# 2. worker AND scheduler in one service
celery -A godeye_engine.celery_app worker --beat --schedule=/tmp/celerybeat-schedule --loglevel=info
```

Both need the same env: `DATABASE_URL`, `REDIS_URL`, `ENGINE_INTERNAL_SECRET`
(must match the API), an LLM key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`),
`GOOGLE_API_KEY` / image keys, and the `S3_*` set. Leave `FFMPEG_PATH` blank,
ffmpeg is on the image and found via PATH.

**Without the worker service nothing publishes.** The API accepts the schedule
and no process ever dispatches it: posts sit at PENDING past their time with no
error on the row and nothing in any log, because nothing ran.

`--beat` on the worker is what makes that one service both the scheduler and
the consumer. It was previously documented as a third, separate beat service,
which is a container to remember to create and whose absence is completely
silent. If you scale the worker past **one replica**, split beat back out using
`railway.beat.json` and drop `--beat` here: two workers with `--beat` are two
schedulers.

`/health` reports `beat` now, so this failure is visible:

    "beat": "ok (last dispatch 12s ago)"
    "beat": "error: no beat heartbeat in the last 120s..."


### 7. Web. Vercel

- Import the GitHub repo. **Root Directory: `apps/web`** (Vercel then installs
  the pnpm workspace from the repo root automatically; `@godeye/shared` is
  transpiled by Next, so no separate build step is needed). Framework and
  commands are pinned in `apps/web/vercel.json`.
- **Env var:** `NEXT_PUBLIC_API_URL` = your API's public URL (e.g.
  `https://godeye-api.up.railway.app`). It's read at build time, so redeploy
  after changing it.

### 8. Use one domain for both (strongly recommended)

Put the web app and the API on the **same registrable domain**:

| | Host | DNS record (Cloudflare) |
|---|---|---|
| web | `godeyeautomation.com` | CNAME -> `cname.vercel-dns.com` (proxy **off**) |
| api | `api.godeyeautomation.com` | CNAME -> the Railway-provided target (proxy **off**) |

Set **DNS only** (grey cloud), not Cloudflare's orange-cloud proxy. Vercel and
Railway terminate TLS themselves, and proxying causes redirect loops.

This is not cosmetic. On split domains (`*.vercel.app` + `*.up.railway.app`)
the session cookie is **third-party**, and browsers that block those drop it,
the session is lost on every page reload. One domain makes it first-party. The
API detects this automatically by comparing `WEB_URL` and `API_URL`, and uses
the stricter `SameSite=Lax` when they match, so **set `API_URL` too**.

### 9. Point the domains at each other

- API `WEB_URL` → the Vercel URL. Web `NEXT_PUBLIC_API_URL` → the API URL.
- Update every OAuth redirect URI to production and register it in each
  platform's app settings:
  - `REDDIT_REDIRECT_URI` = `https://<api>/connections/reddit/callback`
  - `META_REDIRECT_URI` = `https://<api>/connections/meta/callback`
  - `LINKEDIN_REDIRECT_URI` = `https://<api>/connections/linkedin/callback`
- `GET https://<api>/health` reports `api.payments`, whether the secret key
  and each plan code are set on *that* service. Check it before debugging an
  upgrade button: a key set in the wrong Railway service looks exactly like a
  broken checkout from the browser.
- Point the Paystack webhook (Settings → API Keys & Webhooks) at
  `https://<api>/webhooks/paystack`. There is no separate webhook secret:
  Paystack signs with `PAYSTACK_SECRET_KEY`, so the same value verifies events
  and starts checkouts.
- Set `PAYSTACK_PLAN_PRO/PREMIUM/VIP` to the plan codes (`PLN_...`) of three
  monthly plans priced 19 / 49 / 199 USD. Checkout refuses without them rather
  than taking a one-off payment that never renews.

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
