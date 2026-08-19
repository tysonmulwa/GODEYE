# OAuth

**Findings:** C-1 (CRITICAL), S-11 (MEDIUM). **Standards:** RFC 9700, RFC 7636, RFC 8725.
**Evidence:** `apps/api/test/exploits/c1-oauth-state-is-a-session.exploit.spec.ts`,
`s11-oauth-state-binding.exploit.spec.ts`.

---

## What `state` used to be

A JWT signed with `JWT_ACCESS_SECRET`, carrying `{ orgId, sub, purpose }`, valid
for 30 minutes, with no server-side record.

`JwtAuthGuard` verified signature and expiry and nothing else. So a value whose
entire job is to travel through Meta, TikTok, LinkedIn and Reddit — and to land
in their access logs, in browser history, and in `Referer` headers — **was a
bearer session credential**. Replaying one against `POST /auth/switch-org`, which
carried no `@MinRole`, returned a fresh 15-minute access token and a 30-day
refresh cookie. A leaked query parameter became a permanent session.

Separately (S-11), the state named the workspace that started the flow but was
not bound to the browser finishing it. An attacker could fetch a state for
**their own** workspace, build the provider's authorize URL with it, and get a
victim to complete consent — attaching the victim's Facebook Pages to the
attacker's workspace, with publish rights on them.

## What `state` is now

`apps/api/src/connections/oauth-state.service.ts`.

| Property | Before | Now |
|---|---|---|
| Signing key | `JWT_ACCESS_SECRET` | `OAUTH_STATE_SECRET`, asserted different at boot |
| Type claim | none | `typ: "oauth_state"`, demanded by every verifier |
| `iss` / `aud` | none | set and validated |
| Algorithm | whatever the header said | `HS256` allow-list |
| Lifetime | 30 min | 10 min |
| Replay | unlimited within TTL | single-use 128-bit `jti`, consumed with `GETDEL` |
| Browser binding | none | `SHA-256(nonce)` in the token, nonce in an HttpOnly cookie |
| Provider binding | none | `provider` claim, checked at the callback |
| Role re-check | none | membership and role re-read before anything is persisted |
| PKCE | none | TikTok (S256); see below |

Two independent defences against C-1 on purpose: **different key material** and
**an explicit `typ`**. Either alone can be undone by one plausible refactor.

### Fail-closed

If the state store is unreachable, `GET /connections/:platform/authorize`
answers **503**. It does not issue a state that nothing recorded — that state
would be unprotected and infinitely replayable, which is the finding itself.
Asserted by *"refuses to start an OAuth flow when the state store is
unreachable"*.

### The role re-check

A state lives up to ten minutes, and a person can be demoted or removed inside
that window. `ConnectionsService.beginCallback` re-reads the membership and
requires ADMIN or OWNER before persisting anything, so a member removed
mid-flow cannot attach a channel to the workspace they just left.

## PKCE (RFC 7636)

The plumbing is provider-agnostic: the verifier is stored with the state record
and the challenge goes on the authorize URL. Whether it is *sent* is per-provider:

| Provider | PKCE | Why |
|---|---|---|
| TikTok v2 | **on** | Documented for the web authorization-code flow |
| Meta / Facebook | off | Not documented for the server-side flow |
| Instagram Login | off | Not documented |
| LinkedIn | off | Not documented for the confidential-client flow |
| Reddit | off | Documented for installed apps, not web apps |
| X | n/a | OAuth **1.0a**, a different protocol — see below |

**This is a deliberate deviation from "PKCE on every flow".** Sending
`code_challenge` to a provider that does not document support is a live risk to
a production integration, not a hardening measure: the failure mode is every
customer's connect button breaking, and the mitigation it would add is already
covered by the single-use, browser-bound, 10-minute state. Flip a provider to
`true` in `PKCE_SUPPORTED` the day its documentation says so, and verify against
a real account before deploying.

## Redirect URIs

Every `redirect_uri` is derived server-side from `API_URL` or set explicitly per
provider (`env.callbackUrl`). No route accepts a caller-supplied `redirect_uri`,
there are no wildcards, and no substring matching. The value is trimmed and has
trailing slashes stripped, because providers compare it as a raw string and a
stray space from a hosting dashboard produces an opaque rejection.

## The X flow

X uses OAuth 1.0a, which has no `state`. Its request-token secret is parked in
Redis under `x_oauth:<token>` and deleted on use — it was already single-use and
server-side, and it is the pattern the other five now follow. Its TTL moved from
30 to 10 minutes with them.

## Why the callbacks are `@Public()`

A provider's redirect is a cross-site top-level navigation and carries no
`Authorization` header. The state **is** the authentication — which is exactly
why C-1 and S-11 mattered as much as they did. The binding cookie is
`SameSite=Lax`, which browsers do send on a top-level GET navigation, and
`path=/connections` so it is not attached to anything else.

## Operator notes

- `OAUTH_STATE_SECRET` is required. The API refuses to boot without it, and
  refuses to boot if it equals `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET`.
- Redis is now required to *start* an OAuth flow. It was already required to
  finish an X one.
- **`JWT_ACCESS_SECRET` must be rotated after this deploys.** Every OAuth state
  ever issued by the old code is a live session credential until it is. See
  [KEY-MANAGEMENT.md](./KEY-MANAGEMENT.md) § Rotating `JWT_ACCESS_SECRET`.
  That rotation is a human action; it is not performed by this change.
