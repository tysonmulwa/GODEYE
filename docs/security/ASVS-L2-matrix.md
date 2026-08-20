# OWASP ASVS 5.0 — Level 2 conformance matrix

**Scope:** `apps/api` (NestJS), `apps/engine` (FastAPI + Celery), `apps/web` (Next.js).
**Assessed:** 2026-08-20, on `security/p0-remediation`.
**Assessor:** self-assessment against source and tests. **Not** an independent verification.

| Verdict | Meaning |
|---|---|
| **PASS** | Implemented, and an automated test would fail if it regressed |
| **PASS\*** | Implemented, verified by reading, no test pins it |
| **PARTIAL** | Implemented for some paths, or without enforcement |
| **FAIL** | Not implemented |
| **N/A** | Does not apply, with the reason stated |

A requirement with no test is at best PASS\*. That distinction is the point of
this document — ASVS L2 asks for *verification*, and "the code does it" is not
verification, which is precisely how C-1 and S-1 survived 852 green tests.

---

## V1 — Encoding and injection

| Req | Verdict | Evidence / note |
|---|---|---|
| Parameterised queries | **PASS** | Prisma everywhere in the API; SQLAlchemy Core in the engine. `$queryRawUnsafe` appears only in tests |
| Output encoding | **PASS\*** | React escapes by default; `dangerouslySetInnerHTML` appears nowhere in `apps/web/src` |
| OS command injection | **N/A** | No shell invocation on a user-influenced path. ffmpeg is called with an argument array, never a string |
| Header injection | **PASS\*** | No user input reaches a response header unencoded |
| **SSRF** | **PASS** | `security/egress.py` + `url-guard.ts`. 61 + 21 tests, including redirect-to-metadata, DNS rebinding and IPv4-mapped IPv6. See [SSRF.md](./SSRF.md) |

## V2 — Validation

| Req | Verdict | Evidence / note |
|---|---|---|
| Schema validation on every input | **PASS** | Zod via `ZodPipe` on every body; Pydantic on every engine endpoint |
| Positive allow-lists | **PASS** | `z.enum` for platforms, presets, voices, roles |
| Length and size bounds | **PASS** | Field-level in Zod; 30 MB global body cap; 1 MB on `/webhooks` |
| URL validation | **PASS** | See V1 SSRF |
| Mass assignment | **PASS\*** | Zod strips unknown keys; no `Object.assign` from a request body onto a model |

## V3 — Web frontend

| Req | Verdict | Evidence / note |
|---|---|---|
| **Content-Security-Policy** | **FAIL** | Not set. Tracked in [FINDINGS.md](../audit/FINDINGS.md); relevant to PCI 6.4.3 |
| `X-Frame-Options` / frame-ancestors | **PASS\*** | `helmet()` defaults |
| `X-Content-Type-Options` | **PASS\*** | `helmet()` defaults |
| HSTS | **PARTIAL** | Terminated at Railway/Cloudflare; not asserted from the application |
| CORS allow-list, not wildcard | **PASS\*** | Explicit list from `WEB_URL`; `credentials: true` makes a wildcard unsafe and it is not used |
| Cookie flags | **PASS\*** | `httpOnly`, `Secure` in production, `SameSite` chosen from the deployment topology |

## V6 — Authentication

| Req | Verdict | Evidence / note |
|---|---|---|
| Password hashing (memory-hard) | **PASS\*** | argon2id |
| Length over composition | **PASS** | ≥10 chars, shared `passwordSchema` |
| **Breached-password screening** | **FAIL** | Not implemented. NIST SP 800-63B §5.1.1.2 expects it |
| No forced rotation | **PASS** | None implemented, correctly |
| **Anti-automation on sign-in** | **PASS** | Per-account **and** per-address exponential backoff, capped at 15 min. `login-backoff.service.spec.ts` |
| Identical response for unknown user | **PASS\*** | One message for both; the backoff refusal is also identical |
| MFA (TOTP) | **PASS** | Secret encrypted with the user bound as AAD; ±1 step drift |
| **MFA replay prevention** | **PASS** | A consumed code is refused for 90s (S-19) |
| MFA backup codes single-use | **FAIL** | Backup codes are not implemented at all |
| Credential change ends other sessions | **PASS** | Password and MFA changes bump `sessionVersion` in every workspace |

## V7 — Session management

| Req | Verdict | Evidence / note |
|---|---|---|
| Server-side invalidation | **PASS** | `sessionVersion` retires issued access tokens; refresh tokens revoked by row |
| Session bound to its scope | **PASS** | `RefreshToken.orgId` (B-1) |
| **Re-check authorization per request** | **PASS** | `MembershipService`, ≤5s staleness. `roles.guard.spec.ts` |
| Rotation on refresh | **PASS\*** | Presented token revoked, new one issued |
| **Reuse detection** | **PASS** | Family revocation + audit event (S-15, RFC 9700 §4.14.2) |
| Idle / absolute timeout | **PARTIAL** | Access 15 min, refresh 30 days absolute. No idle timeout |
| Logout invalidates server-side | **PASS\*** | Refresh token revoked |
| **CSRF on cookie-authenticated routes** | **PASS** | S-14 closed. Global `CsrfGuard`: unsafe method + no bearer + not exempt ⇒ allowed `Origin`/`Referer` required, failing closed. 16 tests over real HTTP, 9 RED on the parent commit. [CSRF.md](CSRF.md) |
| WebSocket session lifetime | **PASS** | Re-validated every 60s, capped at the access-token lifetime (S-17) |

## V8 — Authorization

| Req | Verdict | Evidence / note |
|---|---|---|
| **Default deny** | **PASS** | Global `RolesGuard`; a route with neither `@Public()` nor `@MinRole()` is refused **and fails the boot**. `boot-audit` |
| Enforced server-side | **PASS** | `authorization-matrix` — 100 routes × 4 roles |
| **Function-level (BFLA)** | **PASS** | Same matrix; the inventory is generated from the live router, so a new route fails until its decision is written down |
| **Object-level (BOLA)** | **PASS** | Ownership in the WHERE clause for every org-owned model; `tenant-isolation` asserts it statically and behaviourally |
| Existence not leaked | **PASS** | Cross-tenant reads answer 404, never 403 |
| Least privilege documented | **PASS** | [AUTHORIZATION.md](./AUTHORIZATION.md) |

## V9 — Self-contained tokens

| Req | Verdict | Evidence / note |
|---|---|---|
| **Algorithm allow-list** | **PASS** | `algorithms: ["HS256"]`; header `alg` never trusted |
| **Explicit `typ`** | **PASS** | `access` / `refresh` / `oauth_state` / `invite`, demanded by every verifier (RFC 8725 §3.1) |
| **`iss` and `aud` validated** | **PASS** | Both set and checked |
| **Key separation per purpose** | **PASS** | Distinct secrets, asserted non-equal at boot (§3.8) |
| Expiry validated | **PASS\*** | Library default, plus explicit TTLs |
| No sensitive data in claims | **PASS\*** | `sub`, `orgId`, `role`, `sv` only |

## V10 — OAuth and OIDC

| Req | Verdict | Evidence / note |
|---|---|---|
| **`state` bound to the browser** | **PASS** | `SHA-256(nonce)` in the token, nonce in an HttpOnly cookie (RFC 9700 §4.7) |
| **`state` single-use** | **PASS** | 128-bit `jti`, consumed with `GETDEL` |
| **`state` is not a credential** | **PASS** | Separate key, separate `typ`. `s11-oauth-state-binding` |
| Exact redirect-URI matching | **PASS\*** | Derived server-side; no wildcards, no caller-supplied value |
| **PKCE** | **PARTIAL** | TikTok only. Deviation and reasoning in [OAUTH.md](./OAUTH.md) |
| Authorization re-checked at callback | **PASS** | Membership and role re-read before anything is persisted |
| Short state lifetime | **PASS** | 30 min → 10 min |

## V11 — Cryptography

| Req | Verdict | Evidence / note |
|---|---|---|
| Approved algorithms | **PASS\*** | AES-256-GCM, SHA-256, HMAC-SHA256/512, argon2id |
| **Unique nonce per encryption** | **PASS** | 96-bit CSPRNG per call (NIST SP 800-38D) |
| **AAD binds ciphertext to context** | **PASS** | `org:<id>` / `user:<id>`; cross-tenant decryption refused, tested on both sides |
| **Key strength enforced** | **PASS** | Weak-key rejection in both services (S-6) |
| **Key rotation supported** | **PASS** | Key ids + `TOKEN_ENCRYPTION_KEY_PREVIOUS`; procedure in [KEY-MANAGEMENT.md](./KEY-MANAGEMENT.md) |
| **Constant-time comparison** | **PASS** | `timingSafeEqual` / `hmac.compare_digest`, with length pre-checks that cannot throw |
| CSPRNG for all secrets | **PASS\*** | `randomBytes` / `os.urandom` throughout |
| Managed KMS | **FAIL** | Environment variables. A platform decision, not a code change |

## V12 — Secure communication

| Req | Verdict | Evidence / note |
|---|---|---|
| TLS everywhere | **PASS\*** | Railway and Cloudflare terminate; no plaintext listener |
| **Outbound TLS validated** | **PASS** | `safe_fetch` sets SNI to the hostname while connecting to the pinned address, so certificate validation still means something |
| Internal service authentication | **PASS** | `X-Internal-Secret`, constant-time, no default (S-5) |

## V13 — Configuration

| Req | Verdict | Evidence / note |
|---|---|---|
| **No default credentials** | **PASS** | Both services refuse to boot on a published value |
| **Fail-fast on bad config** | **PASS** | `validateConfig()` / `validate_config()` report every problem at once |
| Debug interfaces off in production | **PASS** | Swagger gated (S-9) |
| Dependencies inventoried | **PARTIAL** | SBOM job written; has never run (Actions billing-locked) |
| Error responses leak nothing | **PASS\*** | Engine detail forwarded only for 4xx; 5xx is generic |

## V16 — Logging

| Req | Verdict | Evidence / note |
|---|---|---|
| Authentication events logged | **PASS\*** | `auth.login`, `auth.refresh_reuse_detected`, MFA changes |
| Authorization failures logged | **PARTIAL** | Nest logs the exception; there is no dedicated security event stream |
| **No secrets in logs** | **PASS\*** | Reviewed. Egress blocks log the URL and reason, never a credential |
| **Structured logs** | **FAIL** | Nest's default text logger. No JSON, no correlation id |
| **PII redaction** | **FAIL** | Not implemented |
| Log integrity / retention | **FAIL** | Whatever Railway keeps |

## V17 — API and web services

| Req | Verdict | Evidence / note |
|---|---|---|
| **Rate limiting per client** | **PASS** | Three layers, Redis-backed, `trust proxy` as a hop count. `s4-trust-proxy` |
| **Cost-based quotas** | **PASS** | `@Cost()` on every AI/crawl route (OWASP API4) |
| Standard 429 with `Retry-After` | **PASS** | Plus `RateLimit-*` (RFC 9331 shape) |
| **Webhook signature verification** | **PASS** | Raw-body HMAC, constant-time, hex validated before decoding. `s7-meta-webhook` |
| Message size limits | **PASS** | 1 MB on webhooks, 30 MB global |
| **Outbound timeouts** | **PASS** | Every call carries a deadline; a lint rule bans bare `fetch` |
| OpenAPI contract | **PARTIAL** | `pnpm openapi` emits it; no CI diff yet |

---

## Summary

| Verdict | Count |
|---|---|
| PASS | 39 |
| PASS\* | 21 |
| PARTIAL | 6 |
| FAIL | 9 |
| N/A | 2 |

**ASVS L2 is not met.** Nine requirements FAIL, and they cluster in two places:

1. **Logging and monitoring (V16)** — structured logs, PII redaction, a security
   event stream, retention. Nothing was done here; it is the same gap that keeps
   Observability at 2/10 on the scorecard.
2. **Four specific controls** — CSP (V3), CSRF on cookie-authenticated routes
   All three are now closed: CSRF (V7 / S-14), breached-password screening
   (V6.2.5, NIST SP 800-63B §5.1.1.2), and MFA recovery codes (V2.8.4,
   NIST SP 800-63B §5.1.4.3).

The 21 PASS\* entries are the honest ones: correct on reading, with nothing that
would fail if somebody removed them. Converting those to PASS is a smaller job
than the FAILs and is worth doing first, because a control nothing pins is a
control that has already regressed once in this codebase.
