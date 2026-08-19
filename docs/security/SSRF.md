# Outbound requests (SSRF)

**Findings:** S-2, S-3 (HIGH), S-20 (recon), plus a fourth sink found while fixing them.
**Standards:** CWE-918, CWE-367, OWASP A10 / API7, OWASP SSRF Cheat Sheet.
**Evidence:** `apps/engine/tests/test_egress.py` (61 cases),
`apps/api/test/exploits/s2-s3-ssrf.exploit.spec.ts` (21 cases), plus refusal cases in
`seo.service.spec.ts` and `products.service.spec.ts`.

---

## What was reachable

Three entry points accepted an arbitrary URL and fetched it from inside the
private network, with `follow_redirects=True` and no validation of scheme, host
or resolved address:

| | Entry point | Path |
|---|---|---|
| S-2 | `POST /seo/audit` | `seo.module.ts` → `crawler.py` |
| S-3 | `POST /products/import` | `products.module.ts` → `products/sources.py` |
| S-20 | stored media URLs | `publishers/base.py::download_media`, called from five publishers |

**A fourth turned up while wiring the guard**, and it is the one that makes the
case for a single door: `products/supabase_store.py` reads a Supabase project
URL **scraped out of the customer's own page HTML** and queries it. Nothing about
that code looks like it takes user input, and it does.

Reachable from any of them: cloud metadata (`169.254.169.254`,
`metadata.google.internal`, Alibaba's `100.100.100.200`), every
`*.railway.internal` service including the engine's own `/health` — which echoes
database and Redis error strings — and every host in the deployment network.

The channel was **bidirectional**: parsed responses were stored on `SeoAudit` and
read back through `GET /seo/audits/:id`. Combined with S-1, a VIEWER could drive
all of it.

## The guard

Everything goes through `safe_fetch` in
[`apps/engine/src/godeye_engine/security/egress.py`](../../apps/engine/src/godeye_engine/security/egress.py).

| Control | Rule |
|---|---|
| Scheme | `http`, `https`. `file:`, `gopher:`, `dict:`, `ftp:`, `data:` refused |
| Credentials | `user:pass@` refused — it is also how a URL is made to *look* like it points elsewhere |
| Port | 80 and 443 only |
| Hostname | `localhost`, `metadata`, `instance-data`, and anything ending `.internal`, `.railway.internal`, `.local`, `.localhost`, `.cluster.local`, `.svc` |
| Address | loopback, RFC1918, link-local (169.254/16), CGNAT (100.64/10), unique-local (fc00::/7), multicast, reserved, `0.0.0.0/8`, broadcast |
| IPv4-mapped IPv6 | `::ffff:127.0.0.1` decoded and judged as IPv4 — **the bypass that gets missed** |
| DNS | resolved once; **every** answer must be public, not just the first |
| Connection | made to the address that was validated, with `Host` preserved and TLS SNI set to the name |
| Redirects | automatic redirects **off**; followed by hand, max 3 hops, full revalidation each time |
| Size | streamed with a hard cap (5 MB default, 25 MB for media) |
| Timeouts | 5s connect, 15s total |
| Identity | `User-Agent: GodeyeBot/1.0 (+https://godeyeautomation.com/bot)` |
| Logging | every block records org, URL, hop and reason |

### Two details that are the difference between a real guard and a decorative one

**Connecting to the validated address.** Resolving a name and then letting the
HTTP client resolve it *again* at connect time leaves a window in which the
second answer differs from the first. That is DNS rebinding — CWE-367 applied to
SSRF — and it defeats hostname validation completely. `safe_fetch` rewrites the
URL to the address it checked and sets `sni_hostname` so certificate validation
still means something.

**Manual redirects.** A public URL that answers `302 Location:
http://169.254.169.254/` is the standard bypass, and `follow_redirects=True`
walks straight into it. Both the crawler and the importer had it set.

## Defence at the API boundary too

`apps/api/src/common/url-guard.ts` applies the same rules before anything is
enqueued. The engine's copy is authoritative — it opens the socket and can pin
the address — but the boundary check matters for three reasons:

1. A 200 that queues a task has already lost. The caller learns the URL was
   accepted, and what happens next is out of sight.
2. `SeoAudit` and `AgentRun` rows are created *before* the enqueue, so an
   unvalidated URL left a record and a job even when the worker later refused it.
3. The customer gets a clear, immediate error instead of a task that fails
   silently minutes later.

The two lists are deliberately duplicated rather than shared over the wire: one
of them being unreachable must not turn the other off. The exploit suite runs
the same target list against both, which is what keeps them in step.

## Caller-side changes

- **The SEO ownership gate no longer fails open.** `ownedHost` was null for a
  workspace with no website, which made `isForeign` compute `false` and removed
  the gate entirely. Unknown ownership now needs the same explicit confirmation
  a foreign site does.
- `POST /seo/audit`, `POST /products/import` and their `allowForeign` /
  consent flags all require **ADMIN** (see [AUTHORIZATION.md](./AUTHORIZATION.md)).
  Consent was a boolean the workspace granted itself; it says nothing about
  where a URL points.
- Both routes carry a `@Cost()` so a crawl cannot be used as a cheap amplifier
  (see [RATE-LIMITING.md](./RATE-LIMITING.md)).

## The single door is enforced

`test_no_user_supplied_url_is_fetched_outside_the_guard` fails the build if any
engine module constructs an `httpx.Client` or calls `httpx.get` outside the
allowlist. The allowlist holds four publisher files that talk to **fixed** hosts
written into the source — `graph.facebook.com`, `api.twitter.com`,
`discord.com`, `reddit.com` — where no part of the URL comes from a customer.
A second test asserts every exemption still exists, so a stale one cannot quietly
excuse a rewritten file.

## Not done here — infrastructure

Application-layer filtering is necessary and should not be the only control.
Egress from the worker should also be restricted at the platform layer
(Railway network policy, or an egress proxy). That is a human action on the
hosting account and is recorded as `BLOCKED-ON-HUMAN` in
[SCORECARD.md](../audit/SCORECARD.md).

`robots.txt` is read by the crawler for sitemap discovery but is **not** yet
enforced as a crawl permission. That is a real gap, legal as much as technical,
and it is tracked in [FINDINGS.md](../audit/FINDINGS.md) rather than claimed as
finished.
