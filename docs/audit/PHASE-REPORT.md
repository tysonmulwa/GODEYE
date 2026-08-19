# Phase report — P0 remediation

**Branch:** `security/p0-remediation` · **From:** `21b6733` · **Date:** 2026-08-20

---

## Result

**Every P0 finding is closed, each with a test that was RED before its fix and is
GREEN after.** The exploit suite went from 72 failing to 0.

|  | Phase 0 baseline | Now |
|---|---|---|
| Exploit suite | 10 suites failed · **72 failed**, 5 passed, 5 skipped | **13 suites passed** · **109 passed, 0 failed**, 7 skipped |
| API unit tests | 199 passed | **257 passed** |
| Engine tests | 653 passed | **739 passed** |
| **Total** | **852** | **1,105** |
| Lint rules | did not exist | 6 rules, 280 files, clean |
| Typecheck | clean | clean (api, web, shared) |
| Scorecard | 52 / 100 | **76 / 100** |

**Zero tests were deleted.** Six were changed, each because the behaviour
legitimately changed, and each change is called out in the commit that made it —
the most important being `roles.guard.spec.ts`'s *"passes routes without a
@MinRole requirement"*, which was the S-1 defect written down as an expectation.

## Commits

One concern per commit, finding id in the subject.

| | |
|---|---|
| `8083406` | `fix(config): refuse published defaults and entropy-free keys [S-5][S-6][S-6b]` |
| `4464b5e` | `fix(api): withdraw the Swagger UI in production, keep the contract [S-9]` |
| `5b46144` | `fix(api): make authorization global and default-deny [S-1][C-1]` |
| `5c18397` | `fix(connections): bind OAuth state to the browser and make it single-use [S-11][C-1]` |
| `9b0abc6` | `fix(webhooks): refuse unsigned Meta events instead of storing them [S-7]` |
| `2121342` | `fix(api): make rate limiting per-client, layered and Redis-backed [S-4]` |
| `b3bb0b9` | `fix(engine,api): route every user-supplied URL through one egress guard [S-2][S-3][S-20]` |
| `80bf4c9` | `fix(api): bound every outbound call, and make one payment credit once [B-4][S-8][D-1][D-5]` |
| `75797cb` | `fix(auth): make authorization follow the database, not the token [S-10][S-15][S-16][S-17][S-19][B-1][B-2]` |
| `8d0ffc2` | `fix(engine): refresh platform tokens before they expire [B-7]` |
| `27a5855` · `ddc0d21` | documentation |

## The three that mattered most

**C-1.** OAuth `state` was a JWT signed with `JWT_ACCESS_SECRET`, and the guard
checked signature and expiry only. A value designed to travel through Meta,
TikTok, LinkedIn and Reddit — and to land in their logs, browser history and
`Referer` headers — was a bearer session credential; replaying one against
`POST /auth/switch-org` returned a full session. Closed with **two independent
defences**: separate key material, and an explicit `typ` every verifier demands.
Either alone could be undone by one plausible refactor.

**S-1.** Five controllers had no `RolesGuard`, so a VIEWER could delete every
connection, attach an attacker's bot, burn AI spend and wipe the catalogue. The
worse half was the trap: adding `@MinRole` to any of them compiled and enforced
nothing. Now the guard is global, default-deny, and **the app refuses to boot** if
a route declares no access level. 100 routes × 4 roles are asserted on every CI
run, from an inventory generated out of the live router.

**B-7.** `expiresAt` was written in four places and read in none. Every TikTok
connection stopped working a day after it was made while still displaying
ACTIVE. Nothing errored; posts just stopped. Now refreshed hourly, rotation-aware,
with explicit states and a scheduler that refuses to publish through a dead
connection.

## Why 852 green tests missed all of it

**22 of 45 non-spec files in `apps/api/src` were in the coverage map. The other
23 were never loaded by any test** — including every controller, `app.module.ts`
and `main.ts`. Guards are decorators *on controllers*, so no test had ever
executed a guard chain. `roles.guard.ts` sat at 100% statement and 100% branch
coverage the entire time it was missing from five controllers.

The exploit suite boots the real `AppModule` over a real HTTP listener, so every
controller and every guard chain runs on every invocation.

## Four false greens in my own suite

Found by inspecting *which* tests passed, not by anything failing:

1. Four SSRF targets "refused" — `/seo/audit` is throttled 5/min, so request 6+
   answered **429**, satisfying "≥400 and the engine was not called".
2. "Connections marked EXPIRED" matched `meta.py:419` — a *read* of a status
   nothing wrote.
3. Two default-secret tests passed because `env.ts` loads the repo-root `.env`,
   so deleting a variable let the developer's **real secret** back in.
4. `disableThrottle` called `overrideGuard(ThrottlerGuard)`, but the guard is
   registered under the `APP_GUARD` token — so it did nothing, silently, for the
   whole of Phase 0.

Correcting the first three took the baseline from 60 failures to 72.

## Four deliberate deviations

Each is a case where following the directive literally would have made the system
worse. Full reasoning in [FINDINGS.md](./FINDINGS.md).

1. **`@@unique([action, targetId])` on `AuditLog`** → a dedicated
   `PaymentApplication` table instead. The specified constraint would have thrown
   `P2002` whenever a workspace reconnected a channel or a user saved their name
   twice, because `connection.updated`, `content.updated` and
   `account.profile_updated` legitimately repeat.
2. **PKCE on every flow** → TikTok only. The other four providers do not document
   it for the server-side flow, and sending it risks breaking every customer's
   connect button for protection the single-use browser-bound state already gives.
3. **Member removal at OWNER** → route stays `VIEWER` because anyone must be able
   to *leave*; the service requires ADMIN and outranking to remove somebody else.
4. **ESLint rules** → `scripts/lint-rules.mjs`, six rules, no install step, so CI
   cannot skip a security rule because a dependency failed to resolve.

## What is required from a human before this is finished

Five things, none of which a commit can do. All five are why Security is 8 and
not 10.

1. **Rotate `JWT_ACCESS_SECRET`.** Every OAuth state ever issued is still a live
   session credential until this happens. Runbook and blast radius in
   [KEY-MANAGEMENT.md](../security/KEY-MANAGEMENT.md).
2. **Check whether production runs on a published default.**
   `ENGINE_INTERNAL_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` had defaults printed
   in this repository. That is an active incident, not a code defect.
3. **Determine whether `TOKEN_ENCRYPTION_KEY` was ever the all-zeros value.** If
   so, the remedy is credential rotation at every platform, not re-encryption.
4. **Verify `TRUST_PROXY_HOPS` against the real edge**, with two real clients.
5. **Decide `WebhookEvent`'s fate** — give it a consumer or drop it. Dropping a
   table is destructive and is not mine to do.

## What was not attempted

Stated plainly, because a scorecard row that did not move is easy to misread.

- **Observability** (2/10, unchanged). No traces, metrics, error tracking, alerts
  or structured logs. The largest remaining gap; every preventive control added
  here is invisible in production.
- **Scalability** (4/10, unchanged). No load test. D-4 and D-7 unfixed.
- **UX / Accessibility** (7/10, unchanged). No axe run, no VPAT, still zero
  frontend tests.
- **Backups / DR** (3/10, unchanged). No restore has ever been performed.

## Verification limits

- **Docker is not installed on this machine**, so the 7 S-8/D-1 integration tests
  are skipped locally. They report as **skipped**, never as passed.
- **GitHub Actions is billing-locked**, so the CI workflow — which runs those
  tests against a real Postgres — has never executed. A green badge on this repo
  currently means nothing, and the workflow says so in its own footer.
- Everything reported above was run locally, on this machine, on this branch.

**76/100, with the remaining 24 points itemised and attributed.** Roughly 10 are
blocked on a human action; roughly 14 are work not yet started. None is code that
exists and is untested.
