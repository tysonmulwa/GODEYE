# GODEYE engine (FastAPI + Celery worker + Celery beat).
# Build context is the REPO ROOT:  docker build -f apps/engine/Dockerfile .
#
# One image, three processes — deploy it as three services sharing this image and
# override the start command on each:
#   api    (default)  uvicorn godeye_engine.api:app --host 0.0.0.0 --port $PORT
#   worker            celery -A godeye_engine.celery_app worker --loglevel=info
#   beat              celery -A godeye_engine.celery_app beat --loglevel=info
# Only the api service needs a public port; worker and beat are background workers.

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# ffmpeg is required for video assembly (FFMPEG_PATH can stay blank — it's on PATH).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifest first so the dependency layer caches independently of source changes.
COPY apps/engine/pyproject.toml ./
COPY apps/engine/src ./src
RUN pip install --upgrade pip && pip install ".[openai,google]"

RUN useradd --create-home --uid 10001 godeye && chown -R godeye:godeye /app
USER godeye

EXPOSE 8000
# Exec form wrapping an explicit `sh -c ... exec`, which is not the same as
# shell form and matters for shutdown.
#
# Shell form (`CMD uvicorn ...`) makes Docker run `/bin/sh -c "uvicorn ..."`, so
# PID 1 is the shell and uvicorn is its child. SIGTERM then goes to the shell,
# which does not forward it: the process never shuts down gracefully and the
# container is SIGKILLed when the grace period expires. On a Celery worker that
# means in-flight tasks are killed mid-publish rather than finished, and the
# node never deregisters from the broker.
#
# `exec` replaces the shell with the real process, so it becomes PID 1 and
# receives signals directly. `sh -c` is still there because ${PORT} needs a
# shell to expand it, and hosts inject PORT. Docker's own linter flags the shell
# form for exactly this reason (JSONArgsRecommended).
CMD ["sh", "-c", "exec uvicorn godeye_engine.api:app --host 0.0.0.0 --port ${PORT:-8000}"]
