"""Approval workflow gating (Phase 6) — pure query/logic checks, no DB."""

from datetime import datetime, timedelta

from sqlalchemy.dialects import postgresql

from godeye_engine.tasks.scheduler import (
    APPROVAL_SATISFIED_STATUSES,
    due_posts_query,
)


def compiled_dispatch_sql() -> str:
    now = datetime(2026, 7, 17, 12, 0)
    query = due_posts_query(now, now - timedelta(minutes=5))
    return str(
        query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    )


class TestDispatchApprovalGate:
    def test_query_joins_content_and_org(self):
        sql = compiled_dispatch_sql()
        assert 'JOIN "ContentItem"' in sql
        assert 'JOIN "Organization"' in sql

    def test_query_releases_unapproved_only_when_org_does_not_require_approval(self):
        sql = compiled_dispatch_sql()
        assert '"Organization"."requireApproval" IS false' in sql
        for status in APPROVAL_SATISFIED_STATUSES:
            assert f"'{status}'" in sql

    def test_lock_only_scheduled_post_rows(self):
        # FOR UPDATE OF must target ScheduledPost so joined rows aren't locked
        sql = compiled_dispatch_sql()
        assert 'FOR UPDATE OF "ScheduledPost" SKIP LOCKED' in sql


class TestApprovalStatuses:
    def test_pending_approval_is_not_a_satisfied_status(self):
        assert "PENDING_APPROVAL" not in APPROVAL_SATISFIED_STATUSES
        assert "DRAFT" not in APPROVAL_SATISFIED_STATUSES

    def test_approved_and_downstream_statuses_pass(self):
        assert {"APPROVED", "SCHEDULED", "PUBLISHED"} == set(APPROVAL_SATISFIED_STATUSES)
