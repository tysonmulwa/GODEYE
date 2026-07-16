"""SQLAlchemy access to the shared Postgres database.

The schema is owned by Prisma (packages/db/prisma/schema.prisma); table and
column names here MUST match Prisma's generated names (PascalCase tables,
camelCase columns). The engine only maps the tables it touches.
"""

from __future__ import annotations

import secrets
import string
from datetime import datetime, timezone

from sqlalchemy import (
    ARRAY,
    Boolean,
    Column,
    DateTime,
    Integer,
    MetaData,
    Numeric,
    String,
    Table,
    Text,
    create_engine,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

metadata = MetaData()

AgentRun = Table(
    "AgentRun",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("agent", String, nullable=False),
    Column("status", String, nullable=False),
    Column("taskId", String),
    Column("input", JSONB, nullable=False),
    Column("output", JSONB),
    Column("provider", String),
    Column("model", String),
    Column("inputTokens", Integer),
    Column("outputTokens", Integer),
    Column("costUsd", Numeric(10, 6)),
    Column("durationMs", Integer),
    Column("error", Text),
    Column("createdAt", DateTime(timezone=False)),
    Column("completedAt", DateTime(timezone=False)),
)

ContentItem = Table(
    "ContentItem",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("campaignId", String),
    Column("createdById", String),
    Column("type", String, nullable=False),
    Column("status", String, nullable=False),
    Column("title", String),
    Column("body", Text, nullable=False),
    Column("hashtags", ARRAY(String), nullable=False),
    Column("variants", JSONB),
    Column("abVariants", JSONB),
    Column("evergreen", Boolean, nullable=False, default=False),
    Column("lastRecycledAt", DateTime(timezone=False)),
    Column("aiGenerated", Boolean, nullable=False),
    Column("agentRunId", String),
    Column("createdAt", DateTime(timezone=False)),
    Column("updatedAt", DateTime(timezone=False)),
)

ScheduledPost = Table(
    "ScheduledPost",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("contentItemId", String, nullable=False),
    Column("connectionId", String, nullable=False),
    Column("scheduledAt", DateTime(timezone=False), nullable=False),
    Column("timezone", String, nullable=False),
    Column("status", String, nullable=False),
    Column("variantKey", String),
    Column("planId", String),
    Column("attempts", Integer, nullable=False),
    Column("lockedAt", DateTime(timezone=False)),
    Column("publishedAt", DateTime(timezone=False)),
    Column("externalPostId", String),
    Column("externalPostUrl", String),
    Column("error", Text),
    Column("createdAt", DateTime(timezone=False)),
    Column("updatedAt", DateTime(timezone=False)),
)

SocialConnection = Table(
    "SocialConnection",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("platform", String, nullable=False),
    Column("status", String, nullable=False),
    Column("displayName", String, nullable=False),
    Column("externalId", String),
    Column("encryptedCredentials", Text, nullable=False),
    Column("lastErrorAt", DateTime(timezone=False)),
    Column("lastError", String),
)

BusinessProfile = Table(
    "BusinessProfile",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("businessName", String, nullable=False),
    Column("industry", String, nullable=False),
    Column("description", Text, nullable=False),
    Column("targetAudience", Text, nullable=False),
    Column("location", String),
    Column("website", String),
    Column("products", ARRAY(String)),
    Column("services", ARRAY(String)),
    Column("goals", ARRAY(String)),
    Column("brandVoice", String),
    Column("competitors", ARRAY(String)),
    Column("seasonalNotes", String),
)

SeoAudit = Table(
    "SeoAudit",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("agentRunId", String),
    Column("url", String, nullable=False),
    Column("status", String, nullable=False),
    Column("score", Integer),
    Column("pagesCrawled", Integer, nullable=False),
    Column("findings", JSONB),
    Column("keywords", JSONB),
    Column("metaSuggestions", JSONB),
    Column("schemaMarkup", JSONB),
    Column("sitemapXml", Text),
    Column("robotsTxt", Text),
    Column("error", Text),
    Column("createdAt", DateTime(timezone=False)),
    Column("completedAt", DateTime(timezone=False)),
)

MediaAsset = Table(
    "MediaAsset",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("contentItemId", String),
    Column("kind", String, nullable=False),
    Column("source", String, nullable=False),
    Column("storageKey", String, nullable=False),
    Column("url", String),
    Column("mimeType", String, nullable=False),
    Column("sizeBytes", Integer),
    Column("width", Integer),
    Column("height", Integer),
    Column("durationSec", Numeric),
    Column("prompt", Text),
    Column("preset", String),
    Column("agentRunId", String),
    Column("metadata", JSONB),
    Column("createdAt", DateTime(timezone=False)),
)

BrandKit = Table(
    "BrandKit",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("primaryColor", String, nullable=False),
    Column("secondaryColor", String, nullable=False),
    Column("logoStorageKey", String),
    Column("logoUrl", String),
    Column("fontFamily", String),
    Column("watermarkEnabled", Boolean, nullable=False),
    Column("createdAt", DateTime(timezone=False)),
    Column("updatedAt", DateTime(timezone=False)),
)

PostingPlan = Table(
    "PostingPlan",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("name", String, nullable=False),
    Column("cadence", String, nullable=False),
    Column("customCron", String),
    Column("timezone", String, nullable=False),
    Column("platforms", ARRAY(String), nullable=False),
    Column("preferredTimes", ARRAY(String), nullable=False),
    Column("active", Boolean, nullable=False),
    Column("autoGenerate", Boolean, nullable=False),
    Column("topics", ARRAY(String), nullable=False),
    Column("abTesting", Boolean, nullable=False),
    Column("recycleEvergreen", Boolean, nullable=False),
    Column("generateImages", Boolean, nullable=False),
    Column("lastPlannedAt", DateTime(timezone=False)),
    Column("createdAt", DateTime(timezone=False)),
    Column("updatedAt", DateTime(timezone=False)),
)

AnalyticsSnapshot = Table(
    "AnalyticsSnapshot",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("connectionId", String),
    Column("metric", String, nullable=False),
    Column("value", Numeric, nullable=False),
    Column("dimensions", JSONB),
    Column("capturedAt", DateTime(timezone=False)),
)

UsageRecord = Table(
    "UsageRecord",
    metadata,
    Column("id", String, primary_key=True),
    Column("orgId", String, nullable=False),
    Column("metric", String, nullable=False),
    Column("quantity", Numeric, nullable=False),
    Column("periodStart", DateTime(timezone=False), nullable=False),
    Column("createdAt", DateTime(timezone=False)),
)

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(get_settings().sqlalchemy_url, pool_pre_ping=True, pool_size=5)
    return _engine


def get_session() -> Session:
    global _session_factory
    if _session_factory is None:
        _session_factory = sessionmaker(bind=get_engine(), expire_on_commit=False)
    return _session_factory()


_CUID_ALPHABET = string.ascii_lowercase + string.digits


def new_id() -> str:
    """cuid-shaped unique id (Prisma doesn't enforce the format, only uniqueness)."""
    return "c" + "".join(secrets.choice(_CUID_ALPHABET) for _ in range(24))


def utcnow() -> datetime:
    """Naive UTC now — Prisma stores DateTime as timestamp(3) without tz."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
