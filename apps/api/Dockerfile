# GODEYE API (NestJS + Socket.IO) — build context is the REPO ROOT, not apps/api:
#   docker build -f apps/api/Dockerfile .
# On Railway/Render set the Dockerfile path to apps/api/Dockerfile and leave the
# root directory as the repo root, so the pnpm workspace is available.

# Node 22+ is required: the pinned pnpm 11 uses node:sqlite, which doesn't
# exist on Node 20 (corepack fails with ERR_UNKNOWN_BUILTIN_MODULE).
FROM node:22-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
# openssl: required by Prisma. build-essential/python3: native deps (argon2, sharp).
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Manifests first so dependency installs cache independently of source changes.
# tsconfig.base.json is required: apps/api and packages/shared both extend it,
# and without it tsc silently falls back to an ES3 target and fails to compile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/api ./apps/api
# @godeye/db is the generated Prisma client; @godeye/shared is consumed built.
RUN pnpm --filter @godeye/db generate \
 && pnpm --filter @godeye/shared build \
 && pnpm --filter @godeye/api build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 godeye

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

USER godeye
WORKDIR /app/apps/api
# The app reads PORT (API_PORT) from the environment; hosts inject their own.
EXPOSE 4000
CMD ["node", "dist/main.js"]
