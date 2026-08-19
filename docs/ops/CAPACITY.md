# Capacity

**Rubric row 3.** **Findings:** D-4 (unbounded query), D-7 (missing indexes), plus per-tenant
fairness and queue isolation.

---

## The ceiling, and how it is set

Publishing is not limited by the API. It is limited by the dispatcher, and the
dispatcher's rate is arithmetic:

```
dispatch_due_posts   every 30s          (celery_app.py beat_schedule)
DISPATCH_BATCH       20 posts per tick  (scheduler.py)
worker concurrency   2                  (Dockerfile / Railway start command)
```

**Admission ceiling:** 20 posts / 30 s = **40 posts per minute** claimed.

**Completion ceiling** is the binding one. A publish is a network round trip to
a platform, plus a media upload where there is media:

| Post shape | Typical | Worst observed |
|---|---|---|
| Text only | 0.6–2 s | 8 s |
| With an image | 3–8 s | 25 s |
| With video (upload + platform processing poll) | 20–90 s | 180 s (the soft limit) |

At `--concurrency=2` and a 6-second mean, that is **~20 posts/minute
completed**; with a video-heavy mix at 45 s mean it is **~2.7 posts/minute**.

**So the honest ceiling is a range, not a number: 2–20 posts per minute,
dominated by the media mix.** The audit's "15–25 posts/hour" was an
underestimate — it read the beat interval without accounting for batch size —
and the real constraint is concurrency against media latency, which is a
different lever entirely.

### What actually moves it

| Lever | Effect | Cost |
|---|---|---|
| **Split the `media` queue onto its own worker** | Video renders stop occupying the slots publishing needs. Largest single win | One more Railway service |
| Raise `--concurrency` on the publish worker | Linear until the platforms rate-limit us | Memory; ffmpeg is the reason it is 2 today |
| Raise `DISPATCH_BATCH` | Only helps if completion is not the constraint. Usually it is | None |
| Shorten the beat interval | Reduces latency-to-publish, not throughput | More idle queries |

Queue isolation ships in this branch and is **not yet used in the deployment** —
`task_routes` sends publishing to `publish`, media to `media`, everything else to
`background`, and a default worker still consumes all three. Splitting them is a
deployment change:

```bash
# publish: latency-critical, never behind a render
celery -A godeye_engine.celery_app worker -Q publish --concurrency=4
# media: CPU-bound, its own service, its own memory limit
celery -A godeye_engine.celery_app worker -Q media --concurrency=2
# background: crawls, imports, sweeps
celery -A godeye_engine.celery_app worker -Q background --concurrency=2
```

## Per-tenant fairness

The dispatcher took 20 due posts per tick **with no `ORDER BY` at all**, so which
workspace won was whatever order Postgres returned. A customer with 500 due posts
took every tick until they were done; everybody else's posts read PENDING for
hours with nothing to say why.

Now:

```
row_number() OVER (PARTITION BY "orgId" ORDER BY "scheduledAt")  →  rn <= 4
```

`PER_ORG_PER_TICK = 4` of `DISPATCH_BATCH = 20`. One workspace can take at most a
fifth of a tick while any other has work, and the whole batch when nobody else
does. Oldest-first inside a workspace, so fairness between tenants does not
create starvation within one.

Asserted in `apps/engine/tests/test_dispatch_fairness.py`, which compiles the
query for Postgres and checks the ranking, the cap, and that `FOR UPDATE SKIP
LOCKED` survived the rewrite — losing that would publish the same post twice.

## Queries

**Every `findMany` in `apps/api/src` is bounded.** Enforced by
`scripts/lint-rules.mjs`, which walks the braces rather than matching a line, so
formatting cannot decide whether the rule applies. One exemption, with its reason
in the code: the SEO "delete everything" path, where a bound would leave orphaned
rows and report a clean wipe.

The worst offender was `abReport` (D-4): `analyticsSnapshot.findMany({ orgId,
metric })` with no `take` and no post filter, then a JS loop that discarded
nearly all of it. A workspace with ten channels running six months holds ~43,000
rows, all read to pick two numbers.

It is now `SELECT DISTINCT ON ("scheduledPostId")` scoped to the posts in the
test, reading straight off `(scheduledPostId, capturedAt DESC)` — which required
promoting `scheduledPostId` out of the `dimensions` JSON blob into a real column
(migration `20260820120000`, backfilled, expand-only).

Indexes added for D-7:

| Index | Why |
|---|---|
| `ScheduledPost(contentItemId)` | The A/B report, the duplicate check and the cascade on content deletion all filter on it |
| `ScheduledPost(orgId, status, scheduledAt)` | The fairness ranking sorts within a workspace on every 30-second tick |
| `AnalyticsSnapshot(scheduledPostId, capturedAt DESC)` | `DISTINCT ON` reads it in order |

## Autoscaling policy

**Scale on queue depth, not CPU.** A publish worker is I/O-bound — it spends its
time waiting on Meta — so CPU stays low while the backlog grows, and a CPU-based
policy scales *down* during exactly the incident it should scale up for.

| Queue | Scale up when | Scale down when | Bounds |
|---|---|---|---|
| `publish` | depth > 50 for 2 min, **or** oldest due post > 5 min late | depth < 10 for 10 min | 1–6 |
| `media` | depth > 10 for 5 min | depth = 0 for 15 min | 0–3 |
| `background` | depth > 200 for 10 min | depth < 20 for 20 min | 1–2 |

"Oldest due post is late" is the one that matters: it is the customer-visible
symptom, and it is what the SLO is written against.

The API scales on request rate and p99 latency; it holds no state beyond the
membership cache, which is 5 seconds of staleness by design.

## 🔴 Not measured — the reason this row is not 10/10

**No load test has been run.** `tests/load/publish-throughput.js` is written and
has never executed, because there is no staging environment reachable from here
and running 10× peak against production is not a thing to do without asking.

Every number above the "what actually moves it" table is **arithmetic from the
source and observed single-post timings**, not a measurement. That distinction is
the whole difference between this document and a capacity plan.

To close it:

```bash
# Against staging, with a real token and a real content item.
k6 run -e BASE_URL=https://api-staging.godeyeautomation.com \
       -e TOKEN=… -e CONTENT_ITEM_ID=… -e CONNECTION_ID=… \
       tests/load/publish-throughput.js
```

The script writes `docs/ops/load/publish-throughput.json`. Attach that run and
this row can move; until then it is 4/10 with a plan, not 10/10.

Two things to watch in the first run, both of which would mean the ceiling is
ours rather than the platform's:

1. **429 rate above 25%** — the limiter is the ceiling, not the system. Raise the
   `default` tier for authenticated writes before concluding anything about
   throughput.
2. **p99 write latency climbing while throughput is flat** — the admission path
   is queueing behind the database, most likely on the claim query. Check whether
   `ScheduledPost(orgId, status, scheduledAt)` is being used.
