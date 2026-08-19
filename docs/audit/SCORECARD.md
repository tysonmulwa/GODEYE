# GODEYE Scorecard

**Baseline:** independent audit, 52/100 weighted across 13 dimensions.
**Commit:** `21b6733`. **Target:** 100/100, defensible.

Every row starts at its audit score and is marked **EVIDENCE: none**. That is the
point of this phase: today not one of these numbers is falsifiable. A score is only
allowed to move when the EVIDENCE column names something a third party can run and
watch fail — a test id, a command, a dashboard.

**Rules for changing a row**

1. A score may only rise when EVIDENCE names a reproducible artefact.
2. "The code looks right" is not evidence. `RolesGuard` sits at 100% statement and
   100% branch coverage while being absent from five controllers — a perfectly
   covered unit inside a broken system. That is precisely what this column exists to
   prevent.
3. Evidence must have been RED before it was green. A test written after a fix, that
   has never failed, proves only that it agrees with the code.
4. Lowering a score needs no permission.

---

## Rows

| # | Dimension | Audit | Current | Evidence | What would move it |
|---|---|---:|---:|---|---|
| 1 | **Security** | 3 | 3 | **EVIDENCE: none** | 1 critical + 5 high open. Needs `test:exploits` green: C-1, S-1, S-2/S-3, S-4, S-5, S-6, S-7, S-9, S-10, S-11 — plus the SSRF sink S-20 recon added. |
| 2 | **Reliability** | 5 | 5 | **EVIDENCE: none** | B-4 (0 of 11 fetch calls bounded) and B-7 (tokens never refreshed) are the two that break the product rather than expose it. Needs `healthcheckPath` on all four Railway services and a chaos test that kills the engine mid-request. |
| 3 | **Scalability** | 4 | 4 | **EVIDENCE: none** | Hard ceiling ~15–25 posts/hour (`scheduler.py:107` + `--concurrency=2`), no per-tenant fairness, unbounded `abReport` query. Needs a load test that publishes N posts across M tenants and shows the ceiling moving. |
| 4 | **Observability** | 2 | 2 | **EVIDENCE: none** | No error tracking, no metrics, no traces, no alerting, no structured logging anywhere in the tree. Lowest row and the one that makes every other row harder to prove. |
| 5 | **Backups** | 3 | 3 | **EVIDENCE: none** | Supabase-managed, nothing documented, no restore ever performed. Needs a timed restore into the compose stack, with the wall-clock number recorded. |
| 6 | **Deployment** | 6 | 6 | **EVIDENCE: none** | Docker is sound (multi-stage, non-root, uid 10001). But no `healthcheckPath` in any `railway.json`, and CI does not gate deploys — Railway and Cloudflare ship on push regardless of a red build. |
| 7 | **Configuration** | 5 | 5 | **EVIDENCE: none** | S-5 and S-6: unsafe defaults that produce a *working* system. Needs startup assertions that refuse to boot on a default or weak secret, proven by `s5-s6-s9-config`. |
| 8 | **Secrets** | 6 | 6 | **EVIDENCE: none** | Git history is clean (scanned for AWS/Stripe/Paystack/GitHub/Slack/Anthropic/OpenAI/Google formats — nothing). Held back by the all-zeros key in `.env.example` and by S-6b: `TOKEN_ENCRYPTION_KEY` also seeds the **public** IndexNow key (`indexnow.py:52`). |
| 9 | **Migrations** | 7 | 7 | **EVIDENCE: none** | Ordered, versioned, lock file present — the strongest infrastructure row. No automated apply-and-verify, and D-1 shows a missing index nothing would catch. |
| 10 | **Testing** | 6 | 6 | **EVIDENCE: none** | 852 passing tests, and the audit's two worst findings survived all of them. See the coverage note below — this row is the reason the rest of the scorecard was unfalsifiable. |
| 11 | **Rate limiting** | 2 | 2 | **EVIDENCE: none** | Present, carefully tiered across 26 `@Throttle` sites, and non-functional in production (S-4). One line of config, then `s4-trust-proxy` proves it. |
| 12 | **Code quality** | 8 | 8 | **EVIDENCE: none** | Highest row, and deserved: comments explain *why*, the domain model is careful, `PgEnum` and the claim-token scheduler are genuinely good work. Held back by controllers embedded in `*.module.ts` — which is exactly where S-1 hid. |
| 13 | **UX / A11y** | 7 | 7 | **EVIDENCE: none** | Strong loading/error/empty states, real mobile care (`svh` vs `dvh`), complete SEO. No focus trap on the mobile drawer, no `aria-live` on polled status, no skip link. Zero frontend tests. |

**Weighted total: 52 / 100 — unchanged, and unproven in both directions.**

---

## The measurement that makes row 10 the keystone

Captured at `21b6733` before any change (`docs/audit/baseline-coverage-api.json`):

| Suite | Result | Coverage |
|---|---|---|
| API | 199 passed / 17 suites | stmt 62.33%, branch 53.15%, func 43.90%, line 63.19% |
| Engine | 653 passed | 70% |

Jest instruments only what a test loads. **22 of 45 non-spec files in `apps/api/src`
appear in the coverage map; the other 23 are never loaded by any test — including
every controller, `app.module.ts` and `main.ts`.**

`@UseGuards`, `@MinRole` and `@Throttle` are decorators *on controllers*. So no test
among the 852 has ever executed a guard chain. That is the mechanical reason C-1 and
S-1 survived a fully green suite, and it is why every row above reads EVIDENCE: none
rather than inheriting confidence from the test count.

| File | Statements | Branches | |
|---|---|---|---|
| `common/roles.guard.ts` | 100% | 100% | absent from 5 controllers |
| `common/jwt-auth.guard.ts` | 40% | 0% | accepts OAuth state as a session |
| `connections/connections.service.ts` | 27.5% | 28% | signs state with the session secret |
| `engine/engine.service.ts` | 12.5% | 0% | 0 of 11 calls bounded |
| every controller, `main.ts` | never loaded | never loaded | where the guards live |

---

## Exploit suite — the falsifiable baseline

`pnpm --filter @godeye/api test:exploits` at `a8cad9b`:

```
Test Suites: 10 failed, 1 skipped, 10 of 11 total
Tests:       72 failed, 5 skipped, 5 passed, 82 total
```

| Finding | Spec | State |
|---|---|---|
| C-1 | `c1-oauth-state-is-a-session` | RED — `/auth/me` 200, `switch-org` 200 |
| S-1 | `s1-roles-guard-missing` | RED — 11 write routes reachable by VIEWER |
| S-2, S-3 | `s2-s3-ssrf` | RED — both entry points enqueue internal targets |
| S-4 | `s4-trust-proxy` | RED — shared bucket, and `main.ts` sets no trust proxy |
| S-5, S-6, S-6b, S-9 | `s5-s6-s9-config` | RED |
| S-7 | `s7-meta-webhook` | RED — unsigned events persisted |
| S-10 | `s10-role-revocation` | RED |
| S-11 | `s11-oauth-state-binding` | RED |
| B-4 | `b4-fetch-timeouts` | RED — both probes hit the 60 s test timeout |
| B-7 | `b7-token-refresh` | RED |
| S-8, D-1 | `s8-d1-payment-idempotency` | **SKIPPED** — needs Postgres |

The 5 passes are deliberate controls: a real access token still works; a correctly
signed webhook is still stored; the four correctly wired controllers still enforce
their roles. Without them a "fix" that refuses every request would turn the suite
green.

The 5 skips report as skipped, never as passed. An earlier version of that file
returned early when no database was present, which Jest counts as PASSED — a
security test that quietly no-ops is worse than no test.

**Three of my own assertions were green for the wrong reason** and were corrected
before this baseline was recorded:

| Symptom | Cause | Fix |
|---|---|---|
| 4 SSRF targets "refused" | `/seo/audit` is throttled 5/min; request 6+ answered **429**, satisfying "≥400 and engine not called" | `disableThrottle` on that harness, plus an explicit `not.toBe(429)` |
| "connections marked EXPIRED" passed | grep matched `meta.py:419`, a *read* of a status nothing writes | assertion now requires a write |
| 2 default-secret tests passed | `env.ts:27` loads the repo-root `.env`, so deleting a var let the developer's **real secret** back in | set the literal bad default instead; dotenv does not overwrite |

Removing those false greens surfaced **12 further real failures** (60 → 72).

---

## Blocked

**Docker is not installed on this machine** (`docker`, `podman`, and the Docker
Desktop service are all absent), so `infra/docker/docker-compose.test.yml` is written
and ready but has **never been started here**. Consequences:

- S-8 and D-1 are unproven in either direction — 5 tests, correctly reported skipped.
- The compose file itself is unverified. It is modelled on the working dev stack,
  but "should work" is exactly the kind of claim this phase exists to eliminate.

Unblocking is one command once Docker is present:

```bash
docker compose -f infra/docker/docker-compose.test.yml up -d --wait
pnpm --filter @godeye/db migrate:deploy   # against TEST_DATABASE_URL
pnpm --filter @godeye/api test:exploits
```

Until then row 6 (Deployment) and rows 1/9 cannot be fully evidenced.
