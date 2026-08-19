"""One busy workspace must not starve the rest.

The dispatcher took 20 due posts per tick with **no ORDER BY at all**, so which
workspace won was whatever order Postgres happened to return. A customer with
500 due posts took every tick until they were done, and everybody else's posts
sat reading PENDING for hours with nothing to say why.
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy.dialects import postgresql

from godeye_engine.tasks.scheduler import (
    DISPATCH_BATCH,
    PER_ORG_PER_TICK,
    due_posts_query,
)

NOW = datetime(2026, 8, 20, 12, 0, 0)
STALE = NOW - timedelta(minutes=10)


def compiled() -> str:
    """The dispatcher's claim query, as Postgres will receive it.

    Compiling is the strongest assertion available without a database: a query
    that does not compile cannot run, and the shape below is the fairness.
    """
    return str(
        due_posts_query(NOW, STALE).compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )


def test_the_query_compiles_for_postgres():
    # It did not, for a while: Postgres refuses FOR UPDATE alongside a window
    # function, which is why the ranking sits in a subquery.
    assert compiled()


def test_ranks_within_each_workspace_independently():
    sql = compiled()
    assert "row_number() OVER" in sql
    assert 'PARTITION BY "ScheduledPost"."orgId"' in sql


def test_takes_the_oldest_first_inside_a_workspace():
    # Fairness between tenants must not create starvation inside one.
    sql = compiled()
    assert 'ORDER BY "ScheduledPost"."scheduledAt" ASC' in sql


def test_caps_what_one_workspace_can_take_from_a_tick():
    sql = compiled()
    assert f"rn <= {PER_ORG_PER_TICK}" in sql
    assert PER_ORG_PER_TICK < DISPATCH_BATCH, (
        "a per-org cap at or above the batch size is not a cap"
    )


def test_still_claims_rows_atomically():
    # The fairness ranking must not have cost us the property that makes two
    # dispatchers safe. Losing this would publish the same post twice.
    sql = compiled()
    assert "FOR UPDATE" in sql
    assert "SKIP LOCKED" in sql


def test_still_refuses_a_locked_out_workspace():
    # A trial that ran out unpaid publishes nothing. This clause is load-bearing
    # for revenue and is easy to lose in a rewrite of the surrounding query.
    sql = compiled()
    assert "NOT IN" in sql or "not in" in sql.lower()


def test_still_honours_the_approval_gate():
    sql = compiled()
    assert '"requireApproval"' in sql
    assert "APPROVED" in sql


@pytest.mark.parametrize("per_org,batch", [(1, 20), (4, 20), (10, 10)])
def test_the_knobs_are_actually_wired(per_org, batch):
    sql = str(
        due_posts_query(NOW, STALE, batch=batch, per_org=per_org).compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )
    assert f"rn <= {per_org}" in sql
    assert f"LIMIT {batch}" in sql
