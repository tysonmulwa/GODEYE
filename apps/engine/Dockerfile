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
# Shell form so $PORT expands; hosts inject PORT, default 8000 for local runs.
CMD uvicorn godeye_engine.api:app --host 0.0.0.0 --port ${PORT:-8000}
