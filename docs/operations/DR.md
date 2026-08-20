# Backups and disaster recovery

**ISO 27001 A.8.13 · SOC 2 CC7.5 / A1.2 · GDPR Art. 32(1)(c)**

## Read this first

Before this document, the answer to "what happens if the database is lost" was
*Supabase takes backups*. That is a hosting arrangement, not a recovery plan.
Nobody had ever asked one of those backups to give the data back.

**A backup nobody has restored is a hypothesis.** The moment it stops being a
hypothesis is, by definition, the worst possible moment to discover it was
wrong — which is why the drill below runs on every CI build rather than being a
task somebody schedules.

**Status:** the restore *mechanism* is exercised automatically. A restore of the
**production** database has still never been performed, and the RTO figures
below are therefore still estimates. That is the remaining gap on this row, and
it needs a person with a stopwatch — see [The one thing still
missing](#the-one-thing-still-missing).

## What has to come back

Losing the database is the obvious scenario and not the only one. Four separate
stores, four separate recovery stories, and only one of them is covered by
Supabase.

| | What is in it | If it is lost | Covered by |
|---|---|---|---|
| **Postgres** (Supabase) | Everything transactional: users, workspaces, content, schedules, connections (encrypted), billing | The product is gone | Supabase daily backup + PITR |
| **S3 / object storage** | Generated images and video, brand kits, uploads | Posts reference media that 404s. Content rows survive and render broken | **Nothing. Not backed up.** |
| **Redis** (Upstash) | Rate-limit counters, OAuth state, leader locks, login backoff | Self-healing. Counters reset, in-flight OAuth flows must be restarted | Not needed |
| **Secrets** (Railway/Cloudflare vars) | Every key in [KEY-MANAGEMENT.md](../security/KEY-MANAGEMENT.md) | `TOKEN_ENCRYPTION_KEY` lost = **every stored platform credential is unrecoverable** and every customer reconnects | **Nothing. Not backed up.** |

Two of those four rows say "nothing", and the second one is the dangerous one.
`TOKEN_ENCRYPTION_KEY` is not recoverable from a database backup — it is what
makes the database backup readable. Losing it turns a restore into a
reconnect-everything exercise for every customer at once.

> **Open action.** Store `TOKEN_ENCRYPTION_KEY` in a second place a human can
> reach without Railway — a password manager entry, or a sealed envelope. This
> is a decision about where a secret lives, so it is not one this repository
> makes on its own.

## Objectives

Stated so a real incident can be measured against something rather than
argued about.

| | Target | Basis |
|---|---|---|
| **RPO** (data loss) | ≤ 5 minutes | Supabase PITR granularity. **Unverified** — no point-in-time restore has been performed |
| **RTO** (time to serving) | ≤ 2 hours | Estimate. See the breakdown below |
| **Drill cadence** | Mechanism: every CI run. Production: quarterly | The first is automated; the second is not yet scheduled |

RTO breakdown, all estimates except the restore itself:

| Step | Estimate |
|---|---|
| Decide to restore, page whoever can | 15 min |
| Provision the target database | 10 min |
| Restore the dump | measured by the drill; scales with data |
| Re-point `DATABASE_URL`, redeploy API + engine + worker + beat | 15 min |
| Verify: sign in, list content, publish one post | 20 min |

## The drill

```bash
node scripts/restore-drill.mjs --source "$DATABASE_URL"
```

Dumps, creates a scratch database, restores into it, and compares the copy
against the source table by table, column by column, row by row. It fails on a
single missing row.

It runs in CI against the real Postgres 16 service container, after the
migrations have been applied — so every build proves the dump/restore path
works against the current schema.

Three properties worth knowing:

- **It never writes to the source.** It reads, dumps, and restores elsewhere.
- **It refuses to drop anything not named `restore_drill_*`.** A drill that can
  drop the wrong database is a bigger risk than the one it tests for.
- **An empty restore is not a pass.** Restoring nothing into an empty database
  compares "equal" under any check that only walks the restored side, so the
  comparison walks both and counts rows.

The comparison logic has its own test, runnable with no database at all:

```bash
node scripts/restore-drill.mjs --self-test
```

That exists because the orchestration cannot run outside CI, and a drill that
always passes is worse than no drill — it is believed.

## Restoring for real

### 1. Decide what you are recovering from

| Situation | Action |
|---|---|
| Bad migration, schema wrong | Run the migration's `down.sql`. Every migration has one. **Do not restore.** |
| Bad deploy, data intact | Roll back the deploy. **Do not restore.** |
| Data deleted or corrupted by a bug | **PITR** to just before the bug shipped |
| Database or region lost | **Restore the most recent backup** |

Restoring is the heaviest option and discards everything written since the
target time. The first two rows are far more common than the last two.

### 2. Restore

```bash
# Supabase → Project → Database → Backups → Restore, or PITR to a timestamp.
# Restore into a NEW database. Never over the top of the live one: if the
# restore is wrong you have then lost the evidence as well as the data.

# Verify before pointing anything at it.
node scripts/restore-drill.mjs --source "$RESTORED_DATABASE_URL"
```

### 3. Cut over

```bash
# Railway → each of api, engine, worker, beat → Variables
DATABASE_URL=<the restored database>
```

All four. The worker and beat hold their own connections, and a beat still
pointed at the old database will keep dispatching from it — publishing posts
from a dataset you have just decided is wrong.

### 4. Verify before declaring it over

- [ ] `curl https://api.godeyeautomation.com/health/ready` → ok
- [ ] Sign in
- [ ] Content list loads, and media in it renders (this is the check that
      catches the S3 gap above)
- [ ] A social connection still decrypts — proves `TOKEN_ENCRYPTION_KEY`
      matches the restored rows
- [ ] Schedule a post one minute out and watch it publish
- [ ] Check for double-publishing: the dispatcher claims with
      `FOR UPDATE SKIP LOCKED`, and rows restored in `PUBLISHING` are claimable
      again once the stale-lock window passes

### 5. Afterwards

- [ ] Write down the real RTO. Replace the estimate in this document with it.
- [ ] Note anything the runbook got wrong. A runbook is only as good as its
      last rehearsal.

## The one thing still missing

Everything above is mechanism, and mechanism is testable. What is not tested is
the **production** path: Supabase's own backup and PITR features, on the real
database, at real size.

That needs a person, and roughly an hour:

1. Trigger a Supabase restore into a **new** database.
2. Run `restore-drill.mjs --source` against it.
3. Time it. Write the number in the table above.
4. Do a PITR restore to a timestamp five minutes ago, and confirm the RPO.

Until that is done, RPO ≤ 5 min and RTO ≤ 2 h are **claims about a vendor's
documentation**, not measurements of this system — and this row is scored
accordingly in [SCORECARD.md](../audit/SCORECARD.md).
