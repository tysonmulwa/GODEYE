# GODEYE — Setup Guide

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | tested on 24 |
| pnpm | ≥ 9 | `corepack enable` |
| Python | ≥ 3.12 | tested on 3.13/3.14 |
| Docker Desktop | any recent | for Postgres/Redis/MinIO (or supply your own instances) |

> **No Docker?** GODEYE only needs a Postgres 16 database and a Redis 7 server.
> Point `DATABASE_URL` and `REDIS_URL` at any instances (local installs,
> [Supabase](https://supabase.com) + [Upstash](https://upstash.com) free tiers, etc.)
> and skip step 1.

## 1. Infrastructure

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Starts Postgres (5432), Redis (6379), MinIO (9000/9001, console login `godeye` / `godeye_dev_secret`).

## 2. Environment

```bash
cp .env.example .env
```

Then edit `.env`:

- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — random strings (`openssl rand -hex 32`)
- `TOKEN_ENCRYPTION_KEY` — **exactly 64 hex chars** (`openssl rand -hex 32`); encrypts all
  stored platform credentials. Changing it invalidates existing connections.
- `ENGINE_INTERNAL_SECRET` — any random string; shared between API and engine
- `ANTHROPIC_API_KEY` — from https://console.anthropic.com (the Content Agent needs this;
  `OPENAI_API_KEY` works as a fallback provider)
- **Image generation** (optional): Anthropic can't generate images, so set
  `OPENAI_API_KEY` and keep `IMAGE_PROVIDER=openai` to enable AI images via
  `gpt-image-1`. Alternatively set `GOOGLE_API_KEY` and `IMAGE_PROVIDER=google`
  for Imagen. Without an image key, text/scheduling/autopilot all still work;
  only image generation is disabled (with a clear error).

- **Video generation** (optional): needs `OPENAI_API_KEY` (scene images + TTS voiceover)
  **and ffmpeg** on the machine running the engine. Windows:
  `winget install Gyan.FFmpeg` (then restart the terminal), or download from
  https://www.gyan.dev/ffmpeg/builds/ and set `FFMPEG_PATH` in `.env` to the
  ffmpeg executable. Without ffmpeg, video generation fails fast with an install
  hint before any money is spent.

> **Note on Instagram + image URLs:** Instagram's Graph API and some others fetch
> the image over the public internet. The MinIO URL (`localhost:9000`) works for
> Telegram/Discord/Facebook in local testing, but real Instagram publishing needs
> a publicly reachable URL (tunnel MinIO via ngrok, or use real S3 + CloudFront).

## 3. Node workspaces + database

```bash
pnpm install
pnpm db:migrate     # creates the schema (answer the migration name prompt, e.g. "init")
pnpm db:seed        # demo login: demo@godeye.app / godeye-demo-123
```

## 4. Python engine

```bash
cd apps/engine
python -m venv .venv
.venv\Scripts\activate      # Windows   (Linux/macOS: source .venv/bin/activate)
pip install -e ".[dev]"
```

## 5. Run everything

Terminal 1 — web + API:

```bash
pnpm dev
```

Terminal 2 — engine (FastAPI :8000 + Celery worker + Beat):

```bash
cd apps/engine && .venv\Scripts\activate
python -m godeye_engine.run
```

Open http://localhost:3000 · API docs at http://localhost:4000/api/docs

---

## Platform credentials

### Telegram (2 minutes, free)
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **bot token**.
2. Create a channel, add the bot as **administrator** with post permission.
3. In GODEYE → Connections → Telegram: paste the token and the channel handle
   (`@mychannel`) or numeric id (`-100…`).

### Discord (5 minutes, free)
1. https://discord.com/developers/applications → New Application → **Bot** → Reset Token → copy it.
2. OAuth2 → URL Generator: scope `bot`, permission `Send Messages` → open the URL, invite the
   bot to your server.
3. In Discord enable Developer Mode (Settings → Advanced), right-click the target channel →
   **Copy Channel ID**.
4. Connect in GODEYE with the token + channel id.

### Reddit (5 minutes, free)
1. https://www.reddit.com/prefs/apps → create app → type **script**.
2. Put the app's client id + secret in the server `.env`
   (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and a descriptive `REDDIT_USER_AGENT`).
3. Users connect with their Reddit username/password + default subreddit.
   ⚠️ Accounts with Google-SSO-only login or 2FA need an app password / password set.

### X / Twitter (requires a developer account)
1. https://developer.x.com → create a Project and an App.
2. In the app's User authentication settings, enable **OAuth 1.0a** with
   **Read and Write** permissions.
3. Keys and tokens tab → generate the **API Key & Secret** (consumer keys) and an
   **Access Token & Secret**. The access token must be created *after* setting Read+Write.
4. Connect in GODEYE with those four values. Free-tier apps can post but have low limits.

### LinkedIn (requires a developer app)
1. https://developer.linkedin.com → create an app linked to a Company Page.
2. Add the products **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
3. Auth tab → set the redirect URL to
   `http://localhost:4000/connections/linkedin/callback` (matches `LINKEDIN_REDIRECT_URI`).
4. Put the Client ID / Client Secret in `.env`, then connect via the OAuth button in GODEYE.
   Tokens last ~60 days; the connection stores its expiry and will show as EXPIRED to reconnect.

### Meta — Facebook Pages + Instagram (requires a Meta developer app)
1. https://developers.facebook.com → Create App (type **Business**).
2. Add the **Facebook Login for Business** product. Set Valid OAuth Redirect URI to
   `http://localhost:4000/connections/meta/callback` (must match `META_REDIRECT_URI`).
3. Copy the App ID / App Secret into `.env` (`META_APP_ID`, `META_APP_SECRET`).
4. While the app is in **Development mode**, only users with a role on the app can connect —
   add yourself as admin/tester. Live publishing to arbitrary users requires App Review for:
   `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
   `instagram_content_publish`, `business_management`.
5. Instagram must be a **Business/Creator account linked to a Facebook Page**.
   Note: Instagram publishing requires an image — available once image generation ships (Phase 3).

---

## Tests

```bash
pnpm --filter @godeye/api test        # Jest — auth, crypto, scheduling
cd apps/engine && python -m pytest    # engine — agent, publishers, crypto interop
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required environment variable` | Copy `.env.example` → `.env` and fill it in |
| API says "automation engine is not running" | Start terminal 2 (`python -m godeye_engine.run`) |
| Generation stuck QUEUED | Celery worker not running or Redis down (`docker compose ps`) |
| Prisma can't reach DB | Postgres not up, or `DATABASE_URL` doesn't match compose credentials |
| Celery on Windows errors | The runner already uses `--pool=solo`; keep it |
