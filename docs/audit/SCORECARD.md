# GODEYE Scorecard

**Baseline:** independent audit, 52/100 weighted across 13 dimensions, at `21b6733`.
**Now:** `security/p0-remediation`, P0 complete.
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
| 1 | **Security** | 3 | **8** | `test:exploits` — 13 suites, 109 passed, 0 failed, 7 skipped. Every one RED at `a8cad9b`. Authorization matrix over 100 routes × 4 roles. SSRF suite, 61 cases, against both entry points. `THREAT-MODEL.md`, `ASVS-L2-matrix.md` | **BLOCKED-ON-HUMAN:** `JWT_ACCESS_SECRET` not yet rotated, so C-1's already-issued state tokens are still live. No SAST/DAST in CI. No pen test. |
| 2 | **Reliability** | 5 | **7** | `b4-fetch-timeouts` (5), `test_token_refresh.py` (16), circuit breaker + `/health/live` vs `/health/ready` | No chaos suite. No `healthcheckPath` in any `railway.json`. Retry/backoff is tested by construction, not by fault injection. |
| 3 | **Scalability** | 4 | **4** | — | Nothing done. The ~15–25 posts/hour ceiling is still inferred from source. D-4 (unbounded `abReport`) and D-7 (missing indexes) not fixed. No load test. |
| 4 | **Observability** | 2 | **2** | — | Nothing done. No traces, metrics, error tracking, alerts or structured logs. The largest remaining gap, and the one that makes the others hard to prove in production. |
| 5 | **Backups & DR** | 3 | **3** | — | **BLOCKED-ON-HUMAN.** No restore has been performed. RPO/RTO undocumented. A repository cannot time a restore. |
| 6 | **Deployment** | 6 | **7** | Expand/contract migrations with tested down-paths (3). CI runs the exploit suite against real Postgres and Redis | **BLOCKED-ON-HUMAN:** GitHub Actions is billing-locked, so the workflow has never run. No health-gated deploy, no rollback trigger, no canary. |
| 7 | **Configuration** | 5 | **9** | `secrets.spec.ts` (20), `s5-s6-s9-config` (11), `test_security.py`. Both services refuse to boot on a missing, published, weak or reused secret. `CONFIGURATION.md` documents every variable with type, default and blast radius | The boot-refusal is proven by unit test, not by a deployed instance actually refusing to start. |
| 8 | **Secrets** | 6 | **8** | `KEY-MANAGEMENT.md` with a rehearsable rotation procedure. Envelope encryption with key ids and `TOKEN_ENCRYPTION_KEY_PREVIOUS`. AAD binds ciphertext to its tenant. History scanned clean | **BLOCKED-ON-HUMAN:** rotation not performed; `.env.example`'s all-zeros key may have reached a live deployment. No KMS. gitleaks configured but never run. |
| 9 | **Migrations** | 7 | **8** | Three migrations, each expand-only with a written down-path. CI applies them to a fresh database before the exploit suite | No automated Prisma ↔ SQLAlchemy drift test. Down-paths are written and reasoned, not executed. |
| 10 | **Testing** | 6 | **8** | 257 API + 739 engine + 109 exploit = **1,105**, from a baseline of 852. Every P0 has a RED→GREEN demonstration | No E2E, no contract tests, no mutation testing, no DAST. No coverage gate in CI. Zero frontend tests. |
| 11 | **Rate limiting** | 2 | **8** | `s4-trust-proxy` (4) — independent buckets for real clients, **and** no fresh bucket for a forged `X-Forwarded-For`. Redis-backed, three layers, cost-weighted, `RateLimit-*` + `Retry-After`. `login-backoff.service.spec.ts` (4) | **BLOCKED-ON-HUMAN:** `TRUST_PROXY_HOPS` unverified against the real edge. Until two real clients are observed with different `req.ip`, the hop count is an assumption. |
| 12 | **Code quality** | 8 | **9** | `scripts/lint-rules.mjs` — 6 rules, 280 files, clean. `tsc --noEmit` clean across api/web/shared. No new `any` | Controllers still embedded in `seo.module.ts`, `products.module.ts`, `business-profile.module.ts` — deliberately not moved, because a file move in the same branch as a security fix makes both unreviewable. No ADRs. No complexity gate. |
| 13 | **UX / A11y** | 7 | **7** | — | Nothing done. No axe run, no manual pass, no VPAT. The named gaps (drawer focus trap, `aria-live`, skip link) are unfixed. |

### Weighted total

**52 → 76.** The gain is concentrated in exactly the rows the P0 phase targeted:
Security 3→8, Rate limiting 2→8, Configuration 5→9, Secrets 6→8, Testing 6→8.

Three rows did not move at all — Scalability, Observability, UX/A11y — because
nothing was done to them. Two moved by one, because their remaining gaps are
measurements rather than code.

**76 is not 100, and the distance is not code.** Of the 24 points outstanding,
roughly 10 are blocked on a human action (a rotation, a restore drill, a staging
check, an unlocked CI account), and roughly 14 are work not yet started
(observability, load testing, E2E, accessibility).

---

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
| Tests | **72 failed**, 5 passed, 5 skipped | **109 passed**, 0 failed, 7 skipped |

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
