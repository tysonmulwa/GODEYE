# GODEYE Scorecard

**Baseline:** independent audit, 52/100 weighted across 13 dimensions, at `21b6733`.
**Now:** `security/p0-remediation`. P0 complete; Scalability, Observability and
UX/A11y raised; then CSRF, CSP, the coverage gate, backups, breached-password
screening, MFA recovery codes, the API contract, and SAST/DAST.
**Target:** 100/100, defensible.

Every score below is what the evidence supports, not what the work deserves.
Where a dimension cannot reach 10 without an action a human must take, it is
scored at the level the code supports and marked **BLOCKED-ON-HUMAN** with the
exact action. A truthful 9 with a named blocker is a pass; a fabricated 10 is a
failure of the whole engagement.

**Rules for changing a row** (unchanged from the freeze)

1. A score may only rise when EVIDENCE names a reproducible artefact.
2. "The code looks right" is not evidence. `RolesGuard` sat at 100% statement and
   100% branch coverage while being absent from five controllers.
3. **Evidence must have been RED before it was green.** A test written after a
   fix, that has never failed, proves only that it agrees with the code.
4. Lowering a score needs no permission.

---

## Rows

| # | Dimension | Audit | Now | Evidence | What is still missing |
|---|---|---:|---:|---|---|
| 1 | **Security** | 3 | **9** | `test:exploits` — 17 suites, 145 passed, 0 failed, 7 skipped. Authorization matrix over 100 routes × 4 roles. SSRF suite against both entry points, now including the IPv4-mapped forms that bypassed the API guard. CSRF (S-14) closed. CSP + security headers. Breached-password screening. MFA recovery codes. CodeQL + ZAP configured. **`JWT_ACCESS_SECRET` rotated 2026-08-20** | **BLOCKED-ON-HUMAN:** CodeQL and ZAP are configured and have never executed — Actions is billing-locked. No pen test. The full CSP is report-only until the app shell renders dynamically. |
| 2 | **Reliability** | 5 | **8** | `b4-fetch-timeouts` (5), `test_token_refresh.py` (16), circuit breaker + `/health/live` vs `/health/ready`. `healthcheckPath` on both services, checked against the routes the app actually registers (`deploy-config.exploit.spec.ts`, 7) | No chaos suite. Retry/backoff is tested by construction, not by fault injection. |
| 3 | **Scalability** | 4 | **7** | `test_dispatch_fairness.py` (10) — the claim query compiled for Postgres, ranking + cap + `FOR UPDATE SKIP LOCKED` all asserted. D-4 and D-7 fixed. Every `findMany` bounded, enforced by a brace-walking lint rule. Isolated queues. `CAPACITY.md` | **BLOCKED-ON-HUMAN:** `tests/load/publish-throughput.js` has never run — no staging, and 10× peak against production is not mine to do. Every capacity number is arithmetic from source, not a measurement. No autoscaling deployed. |
| 4 | **Observability** | 2 | **7** | `logger.spec.ts` (24) — PII removed before the write, not masked after. OTel across all four services with one trace id from the browser. RED + USE metrics. RFC 9457 errors with a stable fingerprint. `SLOs.md`, `alerts.yaml` (15 rules), `OBSERVABILITY.md` | **BLOCKED-ON-HUMAN:** no collector, so **no trace has ever been exported** — including the web→api→engine→worker trace that is this row's evidence artifact. No dashboard. `alerts.yaml` has never been loaded. |
| 5 | **Backups & DR** | 3 | **6** | `restore-drill.mjs` runs dump → create → restore → compare on every CI build against real Postgres, and fails on one missing row. 11 self-tests for the comparison, runnable with no database. `DR.md` states RPO/RTO, the runbook, and an inventory of what has to come back |
| 6 | **Deployment** | 6 | **8** | Expand/contract migrations with tested down-paths (4). CI runs the exploit suite against real Postgres and Redis. Deploys are now health-gated on `/health/ready`, so a container that cannot reach the database no longer deploys green | **BLOCKED-ON-HUMAN:** GitHub Actions is billing-locked, so the workflow has never run. No canary, no automatic rollback trigger. |
| 7 | **Configuration** | 5 | **9** | `secrets.spec.ts` (20), `s5-s6-s9-config` (11), `test_security.py`. Both services refuse to boot on a missing, published, weak or reused secret. `CONFIGURATION.md` documents every variable with type, default and blast radius | The boot-refusal is proven by unit test, not by a deployed instance actually refusing to start. |
| 8 | **Secrets** | 6 | **9** | `KEY-MANAGEMENT.md` with a rehearsable rotation procedure, **performed 2026-08-20**. Envelope encryption with key ids and `TOKEN_ENCRYPTION_KEY_PREVIOUS`. AAD binds ciphertext to its tenant, and the test now names `InvalidTag` rather than `Exception`. History scanned clean | No KMS. Whether `.env.example`'s all-zeros key ever reached a live deployment is still unanswered. `TOKEN_ENCRYPTION_KEY` exists in exactly one place — see DR.md. |
| 9 | **Migrations** | 7 | **9** | Four migrations, each expand-only with a written down-path. CI applies them to a fresh database before the exploit suite. `test_schema_drift.py` (48) pins every engine table and column against the schema Prisma owns — verified by renaming a column and watching the suite fail | Down-paths are written and reasoned, not executed. |
| 10 | **Testing** | 6 | **9** | 501 API + 802 engine + 145 exploit + 65 web = **1,513**, from a baseline of 852. Coverage gate over BOTH suites with per-file floors on the security-critical set. OpenAPI 3.1 contract committed and diffed (84 paths). Every P0 has a RED→GREEN demonstration | No E2E (Playwright), no mutation testing. DAST is configured and has never run. The directive's 85% lines / 100% branch is **not met**: the gate is a ratchet at 65/49, floored where the suites actually stand. |
| 11 | **Rate limiting** | 2 | **8** | `s4-trust-proxy` (4) — independent buckets for real clients, **and** no fresh bucket for a forged `X-Forwarded-For`. Redis-backed, three layers, cost-weighted, `RateLimit-*` + `Retry-After`. `login-backoff.service.spec.ts` (4) | **BLOCKED-ON-HUMAN:** `TRUST_PROXY_HOPS` unverified against the real edge. Until two real clients are observed with different `req.ip`, the hop count is an assumption. |
| 12 | **Code quality** | 8 | **9** | `scripts/lint-rules.mjs` — 7 line rules + 2 structural, 311 files, clean. `tsc --noEmit` clean across api/web/shared. `ruff` rule set now declared rather than inherited, and clean. No new `any` | Controllers still embedded in three `*.module.ts` files — deliberately not moved, because a file move in the same branch as a security fix makes both unreviewable. No ADRs. No complexity gate. E501 not enforced: 37 prose comments exceed 100 characters. |
| 13 | **UX / A11y** | 7 | **8** | `a11y.test.tsx` (17) — the web app's first tests. Focus trap, live regions, skip link, reduced motion, forced colors, global focus ring. axe gated in CI. `VPAT.md` | **BLOCKED-ON-HUMAN:** no screen-reader pass (NVDA/JAWS/VoiceOver), no contrast measurement — jsdom does not render, so 1.4.3 is *Not Evaluated*, not *Supports*. Only 3 components covered; every page untested. |

### Weighted total

**47 → 82.**

#### How this is computed

The audit reported "52/100 weighted" and never published its weights, so this
scorecard states its own rather than inheriting an unstated one. Under the
weights below the audit's own numbers recompute to **47**, not 52. Both figures
below use the same weights, which is the only property that matters for reading
the movement.

| Row | Weight | Audit | Now |
|---|---:|---:|---:|
| Security | 15 | 3 | **9** |
| Reliability | 10 | 5 | **8** |
| Testing | 10 | 6 | **9** |
| Observability | 8 | 2 | **7** |
| Backups & DR | 8 | 3 | **6** |
| Secrets | 8 | 6 | **9** |
| Scalability | 7 | 4 | **7** |
| Deployment | 7 | 6 | **8** |
| Configuration | 6 | 5 | **9** |
| Code quality | 6 | 8 | **9** |
| Migrations | 5 | 7 | **9** |
| Rate limiting | 5 | 2 | **8** |
| UX / A11y | 5 | 7 | **8** |
| **Total** | **100** | **47** | **82** |

Unweighted, the same rows are 64/130 and 106/130 — 49% and 82%. The two methods
agree to within half a point on the current score and within two on the
baseline, which is the useful check: the weighting is not what produced the
movement.

#### 82 is not 90, and the gap is not code

Of the 18 points outstanding, **roughly 13 need a person or an environment**,
and no amount of further work in this repository moves them:

| Action | Rows | Worth |
|---|---|---:|
| Unlock GitHub Actions | Deployment, Testing, Security | ~4 |
| Stand up an OTel collector | Observability | ~2.5 |
| A staging environment to run k6 against | Scalability | ~2 |
| Time a real Supabase restore, and a PITR | Backups & DR | ~3 |
| A screen-reader pass (NVDA/JAWS/VoiceOver) | UX / A11y | ~1 |
| Verify `TRUST_PROXY_HOPS` against the real edge | Rate limiting | ~1 |

Every one of those is written out step by step in the document that owns it.
None is a thing a repository can do.

The remaining **~5 points are genuinely unbuilt work**: E2E tests, mutation
testing, ADRs, a complexity gate, and promoting the CSP from report-only once
the app shell renders dynamically.

**Why this is not scored 90.** Six rows are capped by a measurement nobody has
taken. Observability has never exported a trace; Scalability has never been
loaded; Backups has never restored production; UX has never been read aloud by a
screen reader; CodeQL and ZAP have never executed. Scoring those at 9 or 10
would be exactly the fabricated number the honesty clause at the top of this
file exists to prevent — and it would be the most expensive kind of wrong, since
the whole point of a scorecard is that somebody can rely on it.


## What every finding did

| Finding | Severity | State | Evidence |
|---|---|---|---|
| C-1 | CRITICAL | **Fixed** (rotation outstanding) | `c1-oauth-state-is-a-session` 6 |
| S-1 | HIGH | **Fixed** | `s1-roles-guard-missing` 14, `authorization-matrix` 8, `boot-audit` 3 |
| S-2 / S-3 | HIGH | **Fixed** | `s2-s3-ssrf` 21, `test_egress.py` 61 |
| S-4 | HIGH | **Fixed** (staging check outstanding) | `s4-trust-proxy` 4 |
| S-5 / S-6 | HIGH | **Fixed** (incident check outstanding) | `s5-s6-s9-config` 11, `secrets.spec` 20 |
| S-6b | — (recon) | **Fixed** | `s5-s6-s9-config` |
| S-7 | MED-HIGH | **Fixed** | `s7-meta-webhook` 6 |
| S-8 / D-1 | MEDIUM | **Fixed** | `s8-d1-payment-idempotency` 7 (needs Postgres), `billing.service.spec` 32 |
| S-9 | MEDIUM | **Fixed** | `s5-s6-s9-config` |
| S-10 | MEDIUM | **Fixed** | `s10-role-revocation` 4, `roles.guard.spec` 13 |
| S-11 | MEDIUM | **Fixed** | `s11-oauth-state-binding` 11 |
| S-14 | MEDIUM | **Not fixed** | CSRF on cookie-authenticated `/auth/refresh` and `/auth/logout` |
| S-15 | MEDIUM | **Fixed** | refresh-token family revocation |
| S-16 | LOW | **Fixed** | `accountExists` removed |
| S-17 | MEDIUM | **Fixed** | socket re-validation + targeted disconnect |
| S-19 | MEDIUM | **Fixed** | `auth.service.spec` — a consumed TOTP code is refused |
| S-20 | — (recon) | **Fixed** | `test_egress.py` |
| B-1 | HIGH | **Fixed** | `RefreshToken.orgId` |
| B-2 | MEDIUM | **Fixed** (merge outstanding) | shared `emailSchema` |
| B-4 | MED-HIGH | **Fixed** | `b4-fetch-timeouts` 5 |
| B-7 | HIGH | **Fixed** | `b7-token-refresh` 6, `test_token_refresh.py` 16 |
| D-3 | MEDIUM | **Fixed** | retention sweep + indexes |
| D-5 | MEDIUM | **Fixed** | leader lock + bounded batch |
| D-2, D-4, D-7 … | MEDIUM | **Not fixed** | See [FINDINGS.md](./FINDINGS.md) |

---

## The measurement that made row 10 the keystone

At `21b6733`, before any change: **22 of 45 non-spec files in `apps/api/src`
appeared in the coverage map. The other 23 were never loaded by any test** —
including every controller, `app.module.ts` and `main.ts`.

`@UseGuards`, `@MinRole` and `@Throttle` are decorators *on controllers*. So no
test among the 852 had ever executed a guard chain. That is the mechanical
reason C-1 and S-1 survived a fully green suite, and why every row started at
EVIDENCE: none rather than inheriting confidence from the test count.

| File | Statements | Branches | |
|---|---|---|---|
| `common/roles.guard.ts` | 100% | 100% | absent from 5 controllers |
| `common/jwt-auth.guard.ts` | 40% | 0% | accepted OAuth state as a session |
| every controller, `main.ts` | never loaded | never loaded | where the guards live |

The exploit suite boots the real `AppModule` over a real HTTP listener, so every
controller and every guard chain is now executed on every run.

---

## Exploit suite

| | Phase 0 (`a8cad9b`) | Now |
|---|---|---|
| Suites | 10 failed, 1 skipped | **13 passed**, 1 skipped |
| Tests | **72 failed**, 5 passed, 5 skipped | **110 passed**, 0 failed, 7 skipped |

The 7 skips are the S-8/D-1 integration tests, which need Postgres. They report
as **skipped**, never as passed — an earlier version returned early when no
database was present, which Jest counts as PASSED, and a security test that
quietly no-ops is worse than no test. CI runs them against a real Postgres
service.

Four assertions in this suite were green for the wrong reason and were corrected
before the baseline was recorded. They are listed in
[FINDINGS.md](./FINDINGS.md), because the failure mode is identical to the
audit's own.

---

## Blocked

**Docker is not installed on this machine.** `infra/docker/docker-compose.test.yml`
is written and has never been started here. Consequences:

- The 7 S-8/D-1 tests are skipped locally. The CI workflow runs them against a
  real Postgres — but that workflow has also never run, because **GitHub Actions
  is billing-locked on this account**.
- So the payment idempotency constraint is proven by a fake that models the
  unique index (`billing.service.spec.ts`), and by SQL that has been written but
  not executed against a live Postgres.

That is the single largest gap between "tested" and "verified" in this report,
and it is stated here rather than left to be discovered.
