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
| engine worker | `apps/engine/Dockerfile` — **Python** | `celery -A godeye_engine.celery_app worker --beat --schedule=/tmp/celerybeat-schedule -Q background,publish,media --loglevel=info --concurrency=2 --max-tasks-per-child=50` |

A Celery command on the API service fails with **"The executable `celery` could
not be found"**: the Node image has no Python in it. This is worth stating
because the failure is quiet in the worst way — the new container never starts,
so Railway keeps the **previous** one serving and retries. The dashboard shows
"building" indefinitely while the old build answers requests, which reads like a
slow build rather than a broken command.

If a service will not start, check its **custom start command** before anything
else.

The precedence rule is per field, and getting it backwards costs hours.
Railway's own wording is that "configuration defined in code will always
override values from the dashboard" -- but that only covers fields the config
file actually names. A field the file **omits** falls back to the dashboard
value, and a redeploy reuses the previous deployment's whole manifest. So an
unwanted dashboard value is invisible in the repo, survives every redeploy, and
is only really removed by naming the field in `railway.json` with the value you
want.

That is the difference between clearing a field in the UI, which fixes one
service until its next redeploy, and declaring it in code, which is what makes
it stay. Every field we care about is declared in the config files for exactly
this reason, empty ones included.

### Pre-deploy commands: leave them empty

Every deployment stalling on **"Running pre-deploy command…"** while others sit
at "Waiting for deployment slot" means a pre-deploy command is set and not
finishing. It holds the slot, so nothing else can deploy — including the fix for
whatever is broken.

Three ways that command hangs rather than fails, all of them silent:

1. **`prisma migrate dev` is interactive.** It prompts, and a container has no
   TTY to answer, so it waits forever. Only `prisma migrate deploy` is safe
   unattended. `pnpm db:migrate` is the `dev` one — do not point a pre-deploy at
   it. Use `pnpm db:deploy:ci`, which is `prisma migrate deploy` with no
   `dotenv-cli` (there is no `.env` file inside an image; the platform injects
   `DATABASE_URL` directly).
2. **Several services migrating at once.** `migrate deploy` takes a Postgres
   advisory lock. Four services each running it on every deploy means three
   block on the first, and a slow migration turns into four stuck deployments.
3. **A script that does not exist.** `npm run migrate` in `apps/api` matches
   nothing — there is no `migrate` script there — and the engine image is Python
   with no npm at all.
4. **The service's own start command, pasted into the pre-deploy field.** This
   is the one that actually happened: `engine-worker` had
   `celery … worker --beat …` as its pre-deploy command. It starts, it works, it
   never exits. Three deployments were still "Deploying" with containers up
   hours later, and the API, engine and beat queued behind them all day. Nothing
   went red — a hung pre-deploy looks exactly like a slow one.

**A warning in this file did not prevent number 4,** which is why there is now a
check instead:

```bash
pnpm railway:drift        # asks Railway what it is running, compares to this repo
```

It reads every service's live config and reports anything set in the dashboard
that no `railway*.json` declares — the class of setting that governs a deploy
while appearing in no diff and no review. Run it after touching anything in the
Railway UI, and when a deploy is stuck with no error to read.

**Migrations are run deliberately, not on every deploy of every service:**

```bash
cd packages/db && npx dotenv -e ../../.env -- npx prisma migrate deploy
```

They are expand-only, so applying them **before** shipping the code is both safe
and correct: old code ignores new columns. That ordering also means a deploy
never has to migrate to succeed, which is why the pre-deploy field should stay
empty.

Every `railway*.json` therefore declares `"preDeployCommand": []` explicitly,
rather than leaving it out and trusting the dashboard to be empty. Leaving it
out is what wedged the project: the field was set in the dashboard, nothing in
the repo contradicted it, and each redeploy inherited it again -- so the
services queued behind a pre-deploy that could never finish, including the
deploys that would have fixed them. `apps/engine/tests/test_railway_config.py`
fails if any config stops declaring it.

### 6. Engine, one image, three services

`apps/engine/Dockerfile` (context = repo root, includes ffmpeg). One image,
three services, each overriding the start command:

```bash
# engine-api — the only one with a port. Receives enqueue calls from NestJS.
uvicorn godeye_engine.api:app --host 0.0.0.0 --port $PORT      # image default

# engine-worker — CONSUMER. No --beat.
celery -A godeye_engine.celery_app worker   -Q background,publish,media   --loglevel=info --concurrency=2 --max-tasks-per-child=50

# engine-beat — SCHEDULER. Exactly one replica.
celery -A godeye_engine.celery_app beat   --schedule=/tmp/celerybeat-schedule --loglevel=info
```

All three need the same env: `DATABASE_URL`, `REDIS_URL`,
`ENGINE_INTERNAL_SECRET` (must match the API), an LLM key, and the `S3_*` set.
Leave `FFMPEG_PATH` blank; ffmpeg is on the image and found via PATH.

#### The two ways this silently does nothing

**`-Q` is not optional.** A Celery worker consumes only the queues named there,
defaulting to `task_default_queue` (`background`) alone. It does **not** pick up
a queue because `task_routes` mentions one. `dispatch_due_posts`,
`reap_stale_runs` and `reap_stuck_posts` all route to `publish`, so a worker
started without `-Q` schedules them forever and runs none of them: beat logs
"Sending due task" every 30 seconds, no error appears anywhere, and the unrouted
tasks keep landing on `background` and succeeding — so the worker looks healthy
while publishing, images and video are all dead.

**Run beat OR `worker --beat`, never both.** Two schedulers fire every periodic
task twice. `periodic_lock.py` makes that harmless rather than corrupting, but
harmless is not intended, and each duplicate still costs a broker round trip.
Beat has no leader election: **one replica**.

Both failures are now visible on `/health`:

```
"queues": "ok (background, media, publish)"
"queues": "error: no consumer for media, publish. Tasks routed there are
           queued and never run; add them to the worker's -Q list."
"beat":   "ok (last dispatch 12s ago)"
```

**engine-worker and engine-beat serve no HTTP.** Leave their healthcheck path
empty and give them no public domain — Railway will otherwise wait forever for a
port that nothing listens on, and the deploy never completes while the process
is perfectly fine.

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
