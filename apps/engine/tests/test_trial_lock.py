"""The paywall, where it actually costs money — pure query checks, no DB.

A read-only workspace is enforced in the API by an interceptor, but the worker
never goes through the API. It reads the database on its own every thirty
seconds, so a trial that has run out has to be visible in the SQL itself.
Otherwise a customer queues a month of posts during their 24 hours and the
worker publishes every one of them, for free, long after the browser started
saying the workspace was locked.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.dialects import postgresql

from godeye_engine.db import BILLING_EXEMPT_SLUGS, locked_org_ids
from godeye_engine.tasks.scheduler import due_posts_query

NOW = datetime(2026, 8, 17, 12, 0)


def literal_sql(statement) -> str:
    return str(
        statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    )


class TestLockedOrgIds:
    def test_selects_only_organisation_ids(self):
        sql = literal_sql(locked_org_ids(NOW))
        assert 'SELECT "Organization".id' in sql

    def test_outer_joins_the_subscription_so_a_missing_row_is_visible(self):
        # LEFT JOIN, not JOIN: a workspace with no subscription at all must be
        # reachable by the query so the "not locked" rule below can spare it.
        sql = literal_sql(locked_org_ids(NOW))
        assert 'LEFT OUTER JOIN "Subscription"' in sql

    def test_a_workspace_with_no_subscription_is_not_locked(self):
        sql = literal_sql(locked_org_ids(NOW))
        assert '"Subscription"."orgId" IS NOT NULL' in sql

    def test_past_due_and_cancelled_are_locked(self):
        sql = literal_sql(locked_org_ids(NOW))
        assert "'PAST_DUE'" in sql
        assert "'CANCELED'" in sql

    def test_a_trial_is_locked_only_once_its_end_has_passed(self):
        sql = literal_sql(locked_org_ids(NOW))
        assert "'TRIALING'" in sql
        assert '"Subscription"."currentPeriodEnd" <=' in sql

    def test_an_active_subscription_is_never_locked(self):
        assert "'ACTIVE'" not in literal_sql(locked_org_ids(NOW))

    def test_the_workspaces_godeye_runs_are_never_locked(self):
        sql = literal_sql(locked_org_ids(NOW))
        assert '"Organization".slug NOT IN' in sql
        for slug in BILLING_EXEMPT_SLUGS:
            assert f"'{slug}'" in sql

    def test_exempt_slugs_match_the_shared_catalogue(self):
        # packages/shared/src/plans.ts holds the same list for the API. Two
        # copies that disagree would have the worker publishing for a workspace
        # the API considers locked, or the reverse.
        assert BILLING_EXEMPT_SLUGS == ("godeye", "patampoa", "mjini-collection")


class TestDuePostsRespectTheLock:
    def test_dispatch_excludes_locked_workspaces(self):
        sql = literal_sql(due_posts_query(NOW, NOW - timedelta(minutes=5)))
        assert '"ScheduledPost"."orgId" NOT IN' in sql
        assert 'LEFT OUTER JOIN "Subscription"' in sql

    def test_the_lock_did_not_disturb_the_approval_gate(self):
        sql = literal_sql(due_posts_query(NOW, NOW - timedelta(minutes=5)))
        assert '"Organization"."requireApproval" IS false' in sql
        assert 'FOR UPDATE OF "ScheduledPost" SKIP LOCKED' in sql
