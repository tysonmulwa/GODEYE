# Authorization

**Status:** enforced globally and gated at boot. **Finding:** S-1 (HIGH).
**Evidence:** `apps/api/test/exploits/authorization-matrix.exploit.spec.ts`,
`s1-roles-guard-missing.exploit.spec.ts`, `boot-audit.exploit.spec.ts`,
`tenant-isolation.exploit.spec.ts`.

---

## What went wrong

Five controllers — `connections`, `media`, `seo`, `products`,
`business-profile` — declared `@UseGuards(JwtAuthGuard)` and no `RolesGuard`.
A **VIEWER**, the role the product sells as read-only, could delete every social
connection, attach an attacker-controlled Telegram bot, spend the workspace's AI
budget on image and video generation, overwrite the brand kit, wipe the product
catalogue, overwrite the business profile that drives every AI output, and
delete every SEO audit.

The worse half was the trap. Adding `@MinRole("ADMIN")` to any of those five
compiled, read correctly in review, and **enforced nothing**, because the guard
that reads the metadata was not in the chain. Per-controller wiring is a decision
every future developer has to get right, silently, forever.

It survived 852 passing tests because guards are decorators *on controllers*, and
no controller was ever loaded by a test — `roles.guard.ts` sat at 100% statement
and 100% branch coverage the whole time.

## How it is enforced now

Three mechanisms, deliberately overlapping.

| | Mechanism | Fails at | File |
|---|---|---|---|
| 1 | `RolesGuard` registered as `APP_GUARD` | request time | `app.module.ts` |
| 2 | `RouteAuditService` refuses to boot on an unannotated route | startup | `common/route-audit.service.ts` |
| 3 | Authorization matrix test over every registered route | CI | `test/exploits/authorization-matrix.exploit.spec.ts` |

**Default-deny.** Every route handler must carry `@Public()` **or**
`@MinRole(...)`. Neither is a `403` at request time and a failed boot before
that. There is no "unspecified" state a route can sit in.

`RolesGuard` authenticates first and authorizes second, so an unannotated route
answers 403 to a genuine member rather than confirming its existence to
everybody. Missing role is never "allow" — that is the fail-closed rule, and it
is the specific line that used to read `if (!required) return true;`.

## The role matrix

| Role | May |
|---|---|
| **VIEWER** | Read everything. No `POST`/`PUT`/`PATCH`/`DELETE` anywhere, no AI generation, no credential export. |
| **EDITOR** | VIEWER + create and edit content, upload media, generate images/video within quota, schedule (subject to the approval gate), apply SEO fixes. |
| **ADMIN** | EDITOR + connections, product catalogue and import, business profile, brand kit, SEO audits and IndexNow submission, invitations, org settings. |
| **OWNER** | ADMIN + billing (checkout and payment verification) and member role changes. |

The machine-readable form is [`authorization-matrix.json`](../../apps/api/test/exploits/authorization-matrix.json):
98 routes, each with its method, path, and declared access level. It is generated
from the live Nest router, so it cannot drift from the code — a new or changed
route fails the inventory test until the decision is written down.

Regenerate after an intentional change:

```bash
UPDATE_AUTHORIZATION_MATRIX=true pnpm --filter @godeye/api test:exploits -- --testPathPattern=authorization-matrix
```

Current distribution: 32 VIEWER, 17 EDITOR, 28 ADMIN, 3 OWNER, 18 public.

### Why billing and role changes moved to OWNER

`POST /billing/checkout` and `POST /billing/verify` were ADMIN. Spending the
workspace's money is the owner's decision, not a delegated one.

`PATCH /members/:userId` (change a member's role) was ADMIN. An ADMIN who can
set roles can set their own to OWNER, which makes ADMIN and OWNER the same role
with extra steps. It is now OWNER.

Both are tightenings, and both will be visible to existing customers — see
[§ Operator notes](#operator-notes).

### The one route the guard cannot fully decide

`DELETE /members/:userId` is two operations behind one path: *leave this
workspace* and *remove that person*. Anyone may leave, so the route cannot demand
ADMIN; removing somebody else requires ADMIN **and** requires outranking them,
which `MembersService.remove` enforces. The guard answers "you are a member" and
the service answers "you may do this, to that person".

It is the only entry in `SERVICE_ENFORCED` in the matrix test, the list is capped
at two by an assertion, and every entry needs its own service-level test. A long
list here would be the old problem wearing a new hat.

## Public routes, and why each one is public

| Group | Routes | Authenticated by |
|---|---|---|
| Pre-session | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/accept-invitation`, `GET /auth/invitations/:token` | Nothing yet, or the invite token itself |
| OAuth callbacks | `GET /connections/{meta,instagram,tiktok,linkedin,reddit,x}/callback` | Single-use `state` + a browser-bound nonce cookie (S-11), or X's request-token secret |
| Webhooks | `POST /webhooks/paystack`, `POST /webhooks/meta`, `GET /webhooks/meta` | HMAC over the raw body (S-7) |
| Infrastructure | `GET /health`, TikTok domain-verification file | Nothing — no data, no side effects |

A callback is public because the provider's browser redirect carries no session
cookie for a cross-site request; the state token *is* the authentication, which
is exactly why C-1 and S-11 mattered so much.

## Object-level authorization (BOLA / OWASP API1)

Every write to an org-owned model carries the org in the `WHERE` clause:

```ts
await this.prisma.socialConnection.delete({ where: { id, orgId } });
```

not a read-then-write pair whose two halves a refactor can separate. Enforced by
a static assertion over `apps/api/src` in `tenant-isolation.exploit.spec.ts`,
scoped to the eleven org-owned models — `User`, `Invitation`, `RefreshToken` and
`Membership` are excluded on purpose, because they are keyed by something the
caller already proved (the token's `sub`, a hashed invite token).

**A row from another workspace answers 404, never 403.** A 403 confirms the id
exists, which is a free enumeration oracle across every tenant.

## Operator notes

Two role requirements were tightened. Nothing breaks silently — both return a
clear 403 — but before deploying, check whether any workspace has an ADMIN who
is expected to:

- start or verify a payment → they now need OWNER, or an owner does it
- change another member's role → they now need OWNER

If that is a problem for a real customer, promote the person rather than loosen
the route.

## Adding a route

1. Give it `@Public()` or `@MinRole(...)`. The app will not boot without one.
2. If it takes an `:id`, scope the query by `orgId`.
3. Run the matrix test; regenerate the inventory if the route is intentional.
4. If it costs money or AI budget, give it a cost-based throttle
   (see [RATE-LIMITING.md](./RATE-LIMITING.md)).
