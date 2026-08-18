# SEO Activation, from findings to real visibility

## The gap

Today `apps/engine/src/godeye_engine/tasks/seo.py` runs: crawl → rules → score →
generated `sitemap.xml` / `robots.txt` → AI keywords + meta rewrites → store.
The user then **copies text out of a card**. Nothing GODEYE produces ever reaches
the live site or a search engine.

So the module diagnoses and stops. Three jobs are missing:

| Job | Question it answers | Status |
| --- | --- | --- |
| **Apply** | Did the fix reach the live site? | missing |
| **Announce** | Does any search engine know? | missing |
| **Verify** | Did it actually help? | missing |

Everything below is about those three.

---

## 1. Apply, the fix has to reach the live site

A crawler is read-only. To change a site, GODEYE needs a **write channel**. There
are four realistic ones, from most universal to most powerful.

### Channel A. Fix Pack (no access required)

Today a finding ends at `recommendation: "Add a meta description…"`. Instead,
emit the **literal patch**: the exact HTML block, plus where it goes, keyed to
the detected stack.

```
findings[i].fix = {
  kind: "meta_description",
  target: "https://site.com/product/x",
  before: null,
  after: '<meta name="description" content="…">',
  where: { wordpress: "Yoast → SEO title/description",
           shopify:   "Product → Search engine listing → Edit",
           html:      "inside <head>, after <title>" }
}
```

Downloadable as a zip: `fixes/`, `sitemap.xml`, `robots.txt`, `schema.jsonld`,
`INSTRUCTIONS.md`. This is the floor, every customer gets it, including the
Wix/Squarespace crowd we'll never have an API for. Build it first because
everything after reuses the same `fix` object.

**Prereq:** the crawler needs stack detection. `PageData` currently has no
`generator` field, add one (read `<meta name="generator">`, `wp-content`,
`cdn.shopify`, `_next/static`, `wixstatic`) so the fix text is stack-correct.

### Channel B. Edge injection via Cloudflare Worker *(recommended for our sites)*

The customer connects Cloudflare with a zone-scoped API token. GODEYE deploys a
Worker on their zone that uses `HTMLRewriter` to rewrite `<title>`, inject
`<meta description>`, OG tags, canonical and JSON-LD **per URL pattern**, and to
serve `/robots.txt`, `/sitemap.xml` and the IndexNow key file.

Why this one matters here: `mjinicollection.com` ships 4.7 KB of HTML and paints
everything in JS. Every product page therefore serves the *same* homepage title
and description, the `duplicate_title` finding isn't a typo, it's structural,
and no amount of copy-pasting fixes it. Edge injection rewrites the HTML **before
it leaves the server**, so crawlers see per-page metadata on a site that has none.
It's also CMS-agnostic: any site behind Cloudflare, no plugin, no repo access.

Non-negotiables:

- **Fail open.** Any error in the Worker → `return fetch(request)` untouched.
  This sits in the request path of a live business; it must be incapable of
  taking the site down.
- **Kill switch.** One click deletes the route and the site is exactly as before.
- **No cloaking.** What we inject must describe what the user actually sees.
  `mission.py` already commits us to white-hat only, this is where that bites.

`CLOUDFLARE` is already in the `Platform` enum.

### Channel C. CMS write-back

- **WordPress**. Application Password + REST; write Yoast/RankMath meta fields,
  media `alt_text`, publish posts.
- **Shopify**. Admin API; `metafields_global_title_tag` / `description_tag` on
  products and pages, image alt.

These cover most real small businesses and are what makes this sellable beyond
our own sites. `WORDPRESS`, `SHOPIFY`, `WOOCOMMERCE` are already in `Platform`.

### Channel D. GitHub pull request

For static / Next / Hugo sites: open a PR editing the metadata, with the diff for
a human to review. Safest channel of all, and the natural fit if a site's source
lives in a repo. `GITHUB` is already in `Platform`.

### The shared object: `SeoFix`

Every channel writes through one model, so the UI, the audit trail and the revert
path are identical no matter how the fix landed:

```prisma
model SeoFix {
  id          String    @id @default(cuid())
  orgId       String
  auditId     String
  findingCode String            // "missing_description", "images_missing_alt"…
  targetUrl   String
  channel     FixChannel        // FIX_PACK | CLOUDFLARE | WORDPRESS | SHOPIFY | GITHUB
  status      FixStatus         // PROPOSED → APPROVED → APPLIED → VERIFIED
  before      Json?             // what was there, revert depends on this
  after       Json              // what we wrote
  appliedAt   DateTime?
  verifiedAt  DateTime?
  error       String?  @db.Text
}
```

This is deliberately `ScheduledPost` shaped. It gets the lock/retry/attempts
machinery in `tasks/scheduler.py` for free, and the Calendar's approve/edit/retry
UX transfers directly.

**Approval is the default.** We never silently rewrite someone's live site. The
user reviews a diff and hits *Apply all 14 safe fixes*. An autopilot toggle
(mirroring `PostingPlan.autoGenerate`) may be allowed for low-risk categories
only, alt text, meta descriptions, never for canonical, robots or redirects.

---

## 2. Announce, visibility is more than on-page

A perfect site nobody has told anyone about is still invisible.

### IndexNow, do this first

Host a key file, `POST` changed URLs, and Bing, Yandex, Seznam and Naver pick
them up in hours rather than weeks. No OAuth, no approval, no quota. Fire it
automatically on every applied fix and every published piece of content. Highest
value per unit of effort in this whole document.

### Google Search Console, the one that makes the rest honest

OAuth; `GOOGLE_SEARCH_CONSOLE` is already in `Platform`. Two directions:

- **Push:** submit the sitemap we already generate.
- **Pull (the real prize):** impressions, clicks and average position per query
  and per page.

Right now `seo_agent.keyword_research` *invents* keyword clusters from crawled
copy. With Search Console it reports the queries the site **already** appears
for. Anything sitting at position 8–20 is striking distance, a page that almost
ranks, where one round of fixes moves real traffic. That single change turns the
keyword feature from plausible-sounding output into measurement.

### Bing Webmaster Tools

Same shape, simpler API, and it accepts the IndexNow key directly.

### Google Business Profile

`GOOGLE_BUSINESS` is in `Platform`. For a Kenyan retail business, ranking in the
local pack is likely worth more than any blue link: hours, photos, posts, review
replies. Under-rated and directly monetisable.

### Keyword clusters → content → the calendar we already built

This is the loop that's missing, and it's entirely internal work. Today the
clusters render in a card and die there. They should become:

```
cluster (commercial intent, no page targets it)
  → content gap
  → brief → Content Agent → blog post + the social posts promoting it
  → existing scheduler → published → IndexNow ping → verify
```

GODEYE already owns every stage after "brief". Wiring this is what makes the SEO
module part of the product rather than a separate tool bolted to the side, and
it's what actually earns rankings over months, as opposed to tidying meta tags.

---

## 3. Verify, otherwise it's theatre

- **Re-crawl** the affected URLs a few hours after apply. Confirm the specific
  `findingCode` is gone. Flip the `SeoFix` to `VERIFIED`, or `FAILED` with the
  reason. A fix nobody checked is a claim, not a result.
- **Score history**, chart `SeoAudit.score` over time. One number today says
  nothing; the slope is the product.
- **Search Console delta** per fixed page: impressions and average position, 28
  days before vs after. This is the answer to "did this work", in the only terms
  a business owner cares about.
- **Weekly digest**, fixed, moved, next.

---

## Honest limits

State these in the UI rather than letting the product imply otherwise:

- **Nobody can guarantee rankings.** We can fix what's broken, publish what's
  missing and make sure engines know. The auction is not ours to win.
- **Google has no general instant-indexing API.** The Indexing API is restricted
  to `JobPosting` and `BroadcastEvent`. Sitemap submission plus IndexNow (Bing,
  Yandex, Seznam) is the legitimate path; anything claiming otherwise is lying.
- **SEO takes weeks.** The verify loop should set that expectation up front.
- **Edge injection sits in the request path.** Fail open, kill switch, no
  exceptions.

---

## Sequencing

| Phase | Ship | Why here |
| --- | --- | --- |
| **1** | `SeoFix` model · Fix Pack · IndexNow · re-crawl verification | No external approvals, no OAuth. Turns the module from report to loop. |
| **2** | Google Search Console (pull + sitemap submit) | Makes keywords real and gives us the measurement everything else is judged by. |
| **3** | One write channel. Cloudflare Worker (our sites) or WordPress/Shopify (the market) | The actual "GODEYE fixed it" moment. |
| **4** | Clusters → content briefs → existing calendar | Connects SEO to the product we already built. |

Phase 1 is self-contained and worth shipping alone.
