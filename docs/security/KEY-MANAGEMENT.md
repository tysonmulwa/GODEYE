# Key management

**Findings:** C-1 (CRITICAL), S-5, S-6, S-6b. **Standards:** NIST SP 800-57 Part 1, NIST SP 800-38D, RFC 8725 §3.8.

---

## The keys, and what each one is for

Purpose separation is the rule. A key does one job; reusing one for two is what
made C-1 a critical finding rather than a note.

| Variable | Protects | Rotating it costs |
|---|---|---|
| `JWT_ACCESS_SECRET` | Signs access tokens (15 min) | Everybody re-authenticates within 15 minutes. No data loss. |
| `JWT_REFRESH_SECRET` | Reserved for refresh-token signing | Nothing today — refresh tokens are random 64-byte values stored hashed, not JWTs. Declared and validated so the two never collapse into one. |
| `OAUTH_STATE_SECRET` | Signs the OAuth `state` parameter (10 min) | Any OAuth flow in progress must be restarted. |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM over stored platform credentials and TOTP secrets | **Needs a re-encryption pass.** See below. |
| `ENGINE_INTERNAL_SECRET` | Authenticates the API to the engine | Both services must be updated together, or the API cannot enqueue. |
| `INDEXNOW_KEY_SECRET` | Seeds the **public** IndexNow key on customer sites | The next audit proposes a new key file to publish. Nothing else. |
| `META_APP_SECRET` | Verifies Meta webhook signatures | Meta-side change; ours is to update the variable. |
| `PAYSTACK_SECRET_KEY` | Bearer token **and** webhook HMAC key | Paystack-side rotation; both uses move together. |

Boot refuses to start if any of these is missing, is a value published in this
repository, is under 32 characters, or fails an entropy check — and refuses if
`OAUTH_STATE_SECRET` equals either JWT secret. See
[CONFIGURATION.md](../CONFIGURATION.md).

Generate every one separately:

```bash
openssl rand -hex 32
```

## 🔴 Required now: rotate `JWT_ACCESS_SECRET`

**This is an outstanding action for a human. It is not done by any commit in
this branch, and until it is done, finding C-1 is only half closed.**

### Why

Before this remediation, the OAuth `state` parameter was a JWT signed with
`JWT_ACCESS_SECRET`, and `JwtAuthGuard` verified signature and expiry and
nothing else. Every `state` value GODEYE ever handed to Meta, TikTok, LinkedIn
or Reddit is therefore **a session credential for the workspace that generated
it**, and those values are sitting in:

- those providers' access logs
- browser history on every machine that completed a connect flow
- `Referer` headers sent onward from the callback page
- any proxy, extension or corporate TLS inspector in between

The code fix stops *new* state tokens working as sessions. It cannot un-issue
the old ones. Only rotating the signing key does that, because it invalidates
every token minted under the old one.

Any state issued in the 30 minutes before the deploy is still within its own
expiry. Beyond that, an expired state cannot be used — but a leaked *access*
token from the same key class can be, which is the second reason to rotate.

### Blast radius

Everybody signed in is signed out and must sign in again. Refresh tokens are
**not** affected — they are random values stored hashed, not signed with this
key — so most sessions recover on their next refresh without a password prompt.
No data is touched. Nothing is deleted.

### Procedure

```bash
# 1. Generate the replacement. Do not reuse anything.
openssl rand -hex 32

# 2. Confirm the code fix is already deployed. Rotating first would sign people
#    out and leave the hole open, which is the worst of both.
curl -s https://api.godeyeautomation.com/health | jq '.api.build'
#    -> must be the commit that carries "make authorization global and default-deny"

# 3. Set it on the API service (Railway -> API -> Variables).
#    JWT_ACCESS_SECRET=<the new value>
#    The engine does not hold this key. Only the API service changes.

# 4. Redeploy the API. Watch the boot log for:
#    "trust proxy: 1 hop(s)"  and no "Refusing to start" line.

# 5. Verify the old key is dead. From a browser that was signed in BEFORE the
#    rotation, load the app: it must bounce to /login or silently refresh.
#    A page that still loads with data means the variable did not take.
```

### After rotating

- [ ] Confirm nobody is holding a support ticket about being signed out — a
      short spike is expected and is the rotation working.
- [ ] Record the date here, and in the next entry of
      [`docs/audit/SCORECARD.md`](../audit/SCORECARD.md).
- [ ] Rotate `OAUTH_STATE_SECRET` at the same time if it was ever set to the
      same value as `JWT_ACCESS_SECRET`. Boot now refuses that, so it cannot be
      true of a running instance, but it could be true of a `.env` on a laptop.

## 🟠 Check before anything else: is production running on a published default?

`ENGINE_INTERNAL_SECRET` defaulted to `"dev-engine-secret"` and
`META_WEBHOOK_VERIFY_TOKEN` to `"godeye-verify"`, on **both** sides of each
channel. A deployment that never set them was authenticated by a string anyone
can read on GitHub.

That is an **active incident**, not a code defect, and the code fix does not
address it — a service still running the old build is still accepting the
default.

```bash
# On each Railway service, check whether the variable is set at all.
# Do NOT print the value into a shared terminal or a ticket.
railway variables --service api    | grep -c ENGINE_INTERNAL_SECRET
railway variables --service engine | grep -c ENGINE_INTERNAL_SECRET
```

If either is unset, or set to `dev-engine-secret`:

1. Treat every request the engine has accepted as potentially unauthenticated.
2. Generate a new value, set it on **both** services, and deploy them together.
   The API cannot enqueue while they disagree, so this is a brief outage window,
   not a rolling change.
3. Same for `META_WEBHOOK_VERIFY_TOKEN`, then re-verify the webhook subscription
   in the Meta app dashboard.

After the deploy this cannot recur: both services refuse to boot on the
published value.

## 🟠 Was `TOKEN_ENCRYPTION_KEY` ever the all-zeros value?

`.env.example` shipped 64 zeros, and it satisfied every check that existed —
Node's `/^[0-9a-fA-F]{64}$/` and the engine's length test. Anyone who copied that
file encrypted **every stored platform credential and every TOTP secret** with a
key that is in the repository.

```bash
# Any ciphertext readable with the published key is compromised. Run this
# against a COPY of the database, never production, and never with the output
# in a shared terminal.
psql "$DATABASE_URL" -Atc \
  'SELECT count(*) FROM "SocialConnection" WHERE "encryptedCredentials" IS NOT NULL'
```

If the key was ever the zeros value, the remedy is **not** re-encryption. It is
credential rotation at every platform: every stored Facebook page token, TikTok
token, Telegram bot token and X secret must be revoked at the provider and the
connections re-made. Re-encrypting only changes the lock on a door whose key has
already been copied.

## Rotating `TOKEN_ENCRYPTION_KEY` (the planned kind)

Ciphertexts carry the id of the key that wrote them, so a rotation does not need
a flag day.

```
v1.<keyId>.<base64 iv>.<base64 tag>.<base64 ciphertext>
```

`keyId` is the first 8 hex of SHA-256 over the key bytes — enough to identify a
key, not enough to reveal one.

### Procedure

1. **Add the new key, keep the old one readable.**

   ```
   TOKEN_ENCRYPTION_KEY=<new>
   TOKEN_ENCRYPTION_KEY_PREVIOUS=<old>
   ```

   Set this on **both** the API and the engine, and deploy both. From this
   moment every write uses the new key and every read tries both.

2. **Re-encrypt.** Anything read and written back rolls forward on its own; a
   connection that is never touched does not. Force the pass by re-saving each
   connection — an operator script, not an endpoint, because it decrypts
   everything it touches.

3. **Confirm nothing is left on the old key.**

   ```sql
   SELECT split_part("encryptedCredentials", '.', 2) AS key_id, count(*)
   FROM "SocialConnection"
   GROUP BY 1;
   ```

   Every row should report the new `keyId`. Legacy rows written before versioning
   existed have no `v1.` prefix at all and will show an empty `key_id`; those are
   read with the current key and no AAD, and re-saving them upgrades the format.

4. **Remove `TOKEN_ENCRYPTION_KEY_PREVIOUS`** and deploy. Leaving it set means
   the retired key is still live, which is most of the reason to rotate gone.

**Do not skip step 3.** Removing the previous key while rows still reference it
makes those credentials unreadable, and the only recovery is asking every
affected customer to reconnect every channel.

## Ciphertext format

```
v1 . <keyId> . base64(iv) . base64(gcmTag) . base64(ciphertext)
```

- **96-bit IV**, CSPRNG, fresh per encryption. A repeated nonce under one key
  breaks GCM completely (NIST SP 800-38D §8.2).
- **AAD** binds the ciphertext to its owner: `org:<orgId>` for platform
  credentials, `user:<userId>` for TOTP secrets. A row lifted from one tenant and
  pasted into another does not decrypt. Both services implement this identically;
  `apps/engine/tests/test_security.py` asserts the cross-tenant refusal.
- The **legacy** three-part format (`iv.tag.ct`, no key id, no AAD) is still
  readable so history is not lost. Nothing writes it.

## What this repository cannot do

- Rotate a production secret. Every procedure above is written for a human with
  access to the hosting dashboards, and deliberately so.
- Tell you whether a key was ever compromised. The checks above tell you whether
  a key is *published*, which is a different and easier question.
- Store keys anywhere better than environment variables. A managed KMS with
  envelope encryption and per-tenant data keys is the next step up, and it is a
  platform decision rather than a code change — see
  [`docs/audit/FINDINGS.md`](../audit/FINDINGS.md).
