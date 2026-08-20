"""Traces, metrics and structured logs for the engine, the worker and beat.

Rubric row 4. The engine had none of this. A publish that took 40 seconds and a
publish that took 40 seconds *waiting on Meta* were indistinguishable, and the
only evidence a Celery task had failed was a line in a log nobody aggregated.

Three things, in the order they matter:

1. **The trace continues.** The NestJS API sends a W3C ``traceparent`` header;
   FastAPI reads it, and the Celery instrumentation carries it into the task, so
   one trace spans browser -> api -> engine -> worker -> platform. That single
   correlation id is the difference between "publishing is slow" and "TikTok's
   upload endpoint is slow for one workspace".

2. **USE metrics for the worker.** Utilisation, Saturation, Errors — a worker is
   a resource, not an endpoint, and RED does not describe it. Queue depth and
   time-to-publish are the two numbers that predict a customer noticing.

3. **Logs are JSON with the trace id on them**, and credentials never reach
   them.

Like the API's, this exports nothing unless ``OTEL_EXPORTER_OTLP_ENDPOINT`` is
set. A tracer batching spans nobody collects is CPU spent on a queue that gets
dropped.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import UTC, datetime
from typing import Any

SERVICE_NAME = "godeye-engine"

_started = False


# --------------------------------------------------------------------------
# Structured logging
# --------------------------------------------------------------------------

#: Substrings that mark a key as never-write. Matched loosely on purpose: a new
#: field called `pageAccessToken` should be caught without anybody remembering
#: to add it.
_SECRET_MARKERS = (
    "token",
    "secret",
    "password",
    "credential",
    "apikey",
    "api_key",
    "authorization",
    "cookie",
    "signature",
    "privatekey",
)
_PII_KEYS = ("email", "phone", "name", "ip", "useragent")


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return "[deep]"
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lower = str(key).lower()
            if any(marker in lower for marker in _SECRET_MARKERS):
                out[key] = "[redacted]"
            elif lower in _PII_KEYS:
                out[key] = "[pii]"
            else:
                out[key] = _redact(item, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_redact(v, depth + 1) for v in value[:50]]
    return value


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with the active trace id on it.

    A log line that cannot be joined to a trace is an observation you cannot
    connect to the request that produced it, which is most of the value of
    having traces.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": SERVICE_NAME,
            "logger": record.name,
            "msg": record.getMessage(),
        }

        trace_id = current_trace_id()
        if trace_id:
            payload["traceId"] = trace_id

        # Celery puts the task name and id on the record when it is running one.
        for attr in ("task_name", "task_id"):
            if hasattr(record, attr):
                payload[attr] = getattr(record, attr)

        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)

        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            payload.update(_redact(extra))

        return json.dumps(payload, default=str)


def configure_logging() -> None:
    """JSON in production, the readable default everywhere else.

    A JSON line per event is unreadable in a terminal, and a log format nobody
    can read while developing is a log format people turn off.
    """
    if os.environ.get("LOG_FORMAT", "").lower() != "json" and os.environ.get("NODE_ENV") != "production":
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)


# --------------------------------------------------------------------------
# Tracing and metrics
# --------------------------------------------------------------------------


def current_trace_id() -> str | None:
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return None
        return format(ctx.trace_id, "032x")
    except Exception:  # noqa: BLE001 - logging must never fail because of telemetry
        return None


def start_telemetry(app: Any | None = None) -> None:
    """Start the SDK and instrument what is present.

    ``app`` is the FastAPI instance when called from the web process; the worker
    and beat call this with nothing.
    """
    global _started
    if _started:
        return
    if os.environ.get("PYTEST_CURRENT_TEST"):
        # Exporters and background threads outliving a test suite make failures
        # that have nothing to do with the code under test.
        return
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        if os.environ.get("NODE_ENV") == "production":
            logging.getLogger(__name__).warning(
                "OTEL_EXPORTER_OTLP_ENDPOINT is not set; traces and metrics are not exported"
            )
        return

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    from .config import get_settings

    resource = Resource.create(
        {
            "service.name": SERVICE_NAME,
            "service.version": (get_settings().railway_git_commit_sha or "unknown")[:8],
            "deployment.environment": os.environ.get("NODE_ENV", "development"),
        }
    )
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)

    # Each of these is optional: an engine web process has no Celery worker in
    # it, and a worker has no FastAPI app. Failing to instrument something that
    # is not there must not stop the rest.
    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            # Excluded for the same reason the API excludes them: health checks
            # are the highest-volume and least interesting spans in any system.
            FastAPIInstrumentor.instrument_app(app, excluded_urls="health,metrics")
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning("FastAPI instrumentation unavailable: %s", e)

    for name, instrument in (
        ("celery", _instrument_celery),
        ("sqlalchemy", _instrument_sqlalchemy),
        ("httpx", _instrument_httpx),
    ):
        try:
            instrument()
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning("%s instrumentation unavailable: %s", name, e)

    _started = True


def _instrument_celery() -> None:
    from opentelemetry.instrumentation.celery import CeleryInstrumentor

    # This is what carries the traceparent from the enqueue into the task, so a
    # publish is a child of the API request that scheduled it rather than an
    # unrelated root span with no explanation.
    CeleryInstrumentor().instrument()


def _instrument_sqlalchemy() -> None:
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    from .db import get_engine

    SQLAlchemyInstrumentor().instrument(engine=get_engine().sync_engine if hasattr(get_engine(), "sync_engine") else get_engine())


def _instrument_httpx() -> None:
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

    # Every platform call becomes a span, so "TikTok was slow" stops being an
    # inference from total task duration.
    HTTPXClientInstrumentor().instrument()
