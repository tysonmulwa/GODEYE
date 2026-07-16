# GODEYE — AI Marketing Operating System

GODEYE is an AI-powered marketing OS: connect your social accounts, website, and
business profile, set goals and a posting schedule — AI agents handle content
creation, image/video generation, SEO, publishing, and analytics autonomously.

## Monorepo layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js frontend (App Router, Tailwind, TanStack Query, Zustand) |
| `apps/api` | NestJS API — auth, orgs, connections, content, scheduling, realtime |
| `apps/engine` | Python automation engine — FastAPI + Celery: AI agents, publishers, scheduler |
| `packages/db` | Prisma schema (single source of truth) + client |
| `packages/shared` | Shared TypeScript types + zod schemas |
| `infra/docker` | Local dev infrastructure (Postgres, Redis, MinIO) |
| `docs` | Architecture, setup, API docs |

## Quick start

```bash
# 1. Infra (Postgres, Redis, MinIO)
docker compose -f infra/docker/docker-compose.yml up -d

# 2. Environment
cp .env.example .env   # then fill in secrets (see docs/SETUP.md)

# 3. Node deps + database
pnpm install
pnpm db:migrate && pnpm db:seed

# 4. Python engine
cd apps/engine
python -m venv .venv && .venv/Scripts/activate   # Windows
pip install -e ".[dev]"

# 5. Run everything
pnpm dev                          # web (3000) + api (4000)
cd apps/engine && python -m godeye_engine.run    # FastAPI (8000) + Celery worker + beat
```

Full setup instructions, including how to obtain credentials for every
platform: [docs/SETUP.md](docs/SETUP.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
