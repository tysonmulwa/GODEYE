"""Realtime event publishing — the NestJS gateway forwards these to browsers."""

from __future__ import annotations

import json
import logging
from typing import Any

import redis

from .config import get_settings

EVENTS_CHANNEL = "godeye:events"
logger = logging.getLogger(__name__)

_client: redis.Redis | None = None


def _get_client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(get_settings().redis_url, decode_responses=True)
    return _client


def publish_event(org_id: str, event: dict[str, Any]) -> None:
    """Fire-and-forget — realtime updates must never break a task."""
    try:
        _get_client().publish(EVENTS_CHANNEL, json.dumps({"orgId": org_id, "event": event}))
    except Exception as e:  # noqa: BLE001
        logger.warning("Realtime publish failed: %s", e)
