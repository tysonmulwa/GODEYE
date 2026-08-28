# Landing page redesign — plan

Status: **built.** Approved with the stated default — D1–D5 as recommended,
**D6 not taken** (the provider boundary was left alone, so the route's total
first-load is reported honestly rather than hit).

Jump to [§6 As built](#6-as-built) for what changed against this plan, the
measured numbers, and the six bugs the work surfaced.

Target: `/` reads like a serious AI infrastructure product (Vercel / Linear /
Runway / ElevenLabs tier), dark-first, while staying honest about what GODEYE
does today.

---

## 0. What I found

### Two things block a literal reading of the brief

**1. The mockups are not in the repo.**

`docs/design/hero-dark.jpg` and `docs/design/hero-light.jpg` do not exist.
Neither did `docs/design/` — I created it to hold this file. I searched the
whole tree for `hero-*` and for every `.jpg`/`.png` outside `node_modules`; the
only images are four uploads under `apps/.media/` and two coverage-report icons.

This matters twice over. I am working from the brief's prose description of the
composition rather than from the artwork, which is survivable — the description
is unusually specific. But the brief also says to use *"the exported render from
the mockup as a static image"* for the hero's centre hub, and that asset does
not exist. See decision **D1**.

**2. There is already a token layer, and the dashboard uses it.**

`src/app/globals.css` carries a complete "Engineered" system: a cool-grey ramp
(`--surface`/`--surface-2`/`--surface-3`, `--ink` through `--ink-4`, `--line`,
`--line-soft`, `--line-hover`), an indigo accent with five states, and a
worked-out glass system (`--glass`, `--glass-edge`, `--glass-shadow`, three
backdrop washes), all surfaced through Tailwind 4's `@theme` as `bg-surface-2`,
`text-ink-2`, `border-line`. Both themes are defined. It is well commented, and
it is what every dashboard screen is built from.

The brief asks for a *new* set of names (`--bg-base`, `--text-primary`,
`--accent-violet`), asks that the layer be reusable so *"the app dashboard can
adopt it later"*, and also says *"do not introduce a new CSS approach — extend
what is there."* Those three pull against each other: a second palette defined
alongside the first is precisely the drift the third instruction forbids. See
decision **D2**.

### What the page is today

Worth stating plainly, because it changes what "redesign" means: `/` is not a
generic template. It is a plain but deliberate editorial page — server-rendered
for crawlers, with six carefully-written capability blocks, a six-question FAQ
wired to `FAQPage` JSON-LD, and four **coded** product previews
(`ComposerPreview`, `CalendarPreview`, `ChannelsPreview`, `SeoPreview`) drawn in
markup specifically so they track the real product instead of ageing away from
it like screenshots.

The copy and those previews are assets. The visual treatment is the part that is
plain: one column, one accent, flat 1px borders, no hierarchy beyond font size,
no motion, and — because the whole app defaults to light — no dark identity at
all. **I plan to keep the copy and the preview components and rebuild everything
around them.**

### Inventory that must survive

Every destination on the page today, with where it goes after:

| What | Destination | After |
|---|---|---|
| Start free for 24 hours | `/register` | Hero primary CTA, **unchanged** |
| Pricing | `/pricing` | Moves hero → nav (brief §3), **destination unchanged** |
| Sign in | `/login` | Moves hero → nav (brief §3), **destination unchanged** |
| Footer: Pricing | `/pricing` | Footer, unchanged |
| Footer: TikTok | `/integrations/tiktok` | Footer, unchanged |
| Footer: Facebook & Instagram | `/integrations/meta` | Footer, unchanged |
| Footer: Privacy | `/privacy` | Footer, unchanged |
| Footer: Terms | `/terms` | Footer, unchanged |

`TRIAL_HOURS` comes from `@godeye/shared` and interpolates into the CTA label
and two FAQ answers. It stays imported, never hardcoded.

**Metadata / structured data — all preserved verbatim:**

- `metadata.title`, `.description`, `.alternates.canonical`
- `metadata.openGraph` including the **repeated `siteName`**. There is a long
  comment on it: Next *replaces* a page's `openGraph` object wholesale rather
  than merging it into the layout's, so dropping the repeat silently removes
  `og:site_name` from the four indexed pages. This was fixed deliberately and is
  easy to undo by accident. It stays.
- `metadata.twitter.title`
- `websiteJsonLd` — homepage only, and the comment explains why a second
  `WebSite` entity elsewhere would weaken the site-name signal rather than
  strengthen it.
- `faqJsonLd` — regenerated from the `FAQ` array, so it tracks whatever the
  accordion renders.
- `<RedirectIfSignedIn />` — first child, untouched.

**Analytics: there is none.** I grepped for gtag / analytics / plausible /
posthog / umami / `track(`. Nothing. So there are no event calls to preserve —
and I will not add any.

### The rest of the ground

- **Next 15 App Router, React 19, Tailwind 4 CSS-first.** No
  `tailwind.config.js` — the theme lives in the `@theme` block in `globals.css`.
- **Fonts already self-host.** `next/font/google` loads Inter, JetBrains Mono
  and Michroma at build time; `csp.ts` pins `font-src 'self' data:` and its
  comment states that `fonts.gstatic.com` deliberately does not belong there.
  The brief's "no render-blocking Google Fonts request" requirement is already
  met — nothing to fix, only a face to add. See **D3**.
- **`next/image` is used nowhere in the app.** Zero occurrences. `public/` holds
  two domain-verification `.txt` files and nothing else. There is no
  proven-working image pipeline on Workers here; any raster we ship is the first
  one ever. Feeds directly into **D1**.
- **CSP is compatible.** `style-src 'self' 'unsafe-inline'` permits the inline
  `style` attributes that stagger animation delays; `img-src 'self' data: blob:
  https:` covers an inlined or self-hosted hero. Nothing in the redesign needs a
  policy change — which I will re-verify at stage 4, not assume.
- **Theme is a `.dark` class** on `<html>`, set by a `useEffect` in
  `theme-toggle.tsx`, **defaulting to light**, with no blocking inline script.
  Marketing has to be dark-first regardless of that toggle. See **D4**.
- **All eight platform marks already exist** as real vector paths in `ui.tsx`
  (`PLATFORM_MARKS`): TikTok, Instagram, Facebook, LinkedIn, X, Reddit, Telegram,
  Discord — plus YouTube, Threads, Pinterest. These are genuine current brand
  marks, not approximations. The orbit reuses the paths; it will not reuse
  `PlatformGlyph`'s flat brand-coloured tile, which is dashboard chrome and would
  read as a sticker sheet in a hero.
- **`framer-motion` v12 is already a dependency** — used by dashboard screens.
  The landing route does not import it today and will not after. Enforced by a
  test, not by intention (**stage 4**).
- **Reusable already:** `use-focus-trap.ts` (tested against WCAG 2.1.2/2.4.3 —
  the mobile drawer will use it rather than a new one), `use-scroll-lock.ts`,
  `lucide-react`, and the skip-link pattern from `(app)/layout.tsx`.
- **Test setup:** vitest + testing-library + **`jest-axe` and `axe-core` already
  installed**, so the accessibility gate is programmatic from the start. Current
  web suite: 83 passing across 4 files.
- **`/docs` does not exist.** See **D5**.

### The measured baseline — and the budget problem

I ran a production build before planning anything, because a 90KB budget is
worth nothing if you do not know where you start.

```
Route (app)                     Size    First Load JS
┌ ○ /                        1.57 kB          115 kB
+ First Load JS shared by all                 103 kB
```

**The landing page is already over the brief's ~90KB budget, and the redesign
has not started.** The page's own code is 1.57 kB. The other 103 kB is the
shared-by-all chunk that every route pays for.

The cause is structural, not a heavy landing page: the **root** `layout.tsx`
wraps everything in `<Providers>` — a TanStack Query client, a toast provider,
and a `useEffect` that calls `tryRefresh()` on load. So `/`, `/pricing`,
`/privacy` and `/terms` — the four public, indexed, logged-out pages — each ship
a full data-fetching stack they never use. `/privacy` is 150 B of content and
103 kB of JavaScript.

The only thing the homepage genuinely needs from that stack is
`RedirectIfSignedIn`, which reads two fields from the zustand auth store (small)
and does not touch React Query at all.

So the budget is reachable, but not by writing a lean landing page — it needs
the provider boundary moved. That is a change to every route in the app, which
makes it your call rather than mine: see **D6**.

---

## 1. Decisions I need from you

These are the only things I am blocked on. Everything else I will just do.

### D1 — the hero hub, with no mockup to export from

The brief specifies a raster centre hub (AVIF + WebP, priority, <180KB) with
coded orbit, flow lines and calendar around it. The render does not exist, and
`next/image` has never been exercised in this repo on Workers.

**My recommendation: build the hub coded too — SVG + CSS, no raster at all.**
Not as a fallback, as the better artefact: roughly 4KB instead of 180KB against
a 90KB budget on a paid edge runtime; sharp at every DPI; no CLS because it has
intrinsic dimensions; cannot regress in a theme it was not exported in; and it
removes the only unproven part of the pipeline. It also matches the reason the
existing previews were coded in the first place.

Alternatives if you would rather have the render: give me the two JPGs and I
will export the hub, or point me at the Figma/source.

### D2 — one token ramp or two

**My recommendation: the brief's semantic names become the public API, defined
against a single ramp**, with the existing `--ink`/`--surface`/`--line` names
kept as aliases so no dashboard screen changes and nothing can drift. Where the
brief's value and the existing value are near-identical (`--accent-violet
#7C6BF7` vs the current indigo `#6366f1`) I take the brief's — a small,
deliberate shift toward violet that the dashboard inherits for free.

The alternative — a separate marketing palette — is faster now and is the thing
that will be inconsistent in three months.

### D3 — Space Grotesk, and what happens to Michroma

The brief asks for Space Grotesk display + Inter body. Inter is already loaded.
Michroma is currently `--font-display` and is used by the logo lockup and app
chrome.

**My recommendation: add Space Grotesk as `--font-display`, keep Michroma under
its own `--font-brand` for the logo only.** Michroma is a wide decorative face —
right for a wordmark, wrong for a 4.5rem headline. Nothing that uses it today
changes. Cost is one extra font family on the marketing route.

### D4 — how the marketing pages stay dark

The app is light-by-default via a class the user can toggle. Marketing must be
dark regardless.

**My recommendation: a `(marketing)` route group whose layout applies the dark
token values to itself and paints its own full-bleed background**, rather than
depending on `.dark` on `<html>`. No flash on load, no dependence on a
`useEffect` that runs after paint, no interference with the dashboard toggle,
and the light mockup's composition still informs the layout as the brief
intends. Marketing simply does not offer a theme switch.

### D5 — the `Docs` nav item points at nothing

There is no `/docs` route and none is planned in `PUBLIC_PAGES`.

**My recommendation: nav reads Product / How it works / Pricing / Integrations**,
where Integrations is a real menu over the two existing pages
(`/integrations/tiktok`, `/integrations/meta`) that are currently reachable only
from the footer. Shipping a nav link to a 404, on the page whose whole job is
credibility, is not a trade I would make. Say the word and I will build `/docs`
instead, but that is a separate piece of work.

### D6 — the 90KB budget needs the provider boundary moved

From the baseline above: `/` is at 115 kB, of which 103 kB is the shared chunk
carrying TanStack Query and the session-refresh effect into pages that have no
session and fetch nothing.

**My recommendation: move `<Providers>` out of the root layout and into the
`(app)` and `(auth)` layouts, and give the homepage's `RedirectIfSignedIn` the
auth store alone.** The public pages then ship React, the Next runtime and their
own markup. I would expect the shared baseline for marketing to land somewhere
in the 60–75 kB range, which puts a real hero comfortably inside 90 kB — but I
will report the measured number, not that estimate.

This is the honest scope note: it touches the root layout and therefore every
route, so it is not "just the landing page". It is also the only route to the
budget you set, and it independently makes the three other indexed public pages
three to four times lighter.

**If you would rather not touch the root layout**, say so and I will build the
redesign anyway — but then the ~90KB target is not achievable, and I will report
the landing route against its 115 kB starting point instead of pretending to a
number I cannot hit. I would rather agree that now than explain it at stage 4.

---

## 2. Stages

Each stage ends with typecheck + lint + production build + screenshots at
390 / 768 / 1440, shown to you before the next one starts.

### Stage 1 — tokens and fonts

| File | Change |
|---|---|
| `src/app/globals.css` | Extend the existing `@theme` and `:root`. Add semantic aliases (`--bg-base`, `--bg-raised`, `--bg-elevated`, `--border-subtle`, `--border-strong`, `--text-primary`, `--text-secondary`, `--text-muted`), the accent set (violet / lilac / cyan / magenta), the **single** `--brand-gradient` recipe, the two glow tokens, the display type scale, and status tokens (`--status-published`, `--status-scheduled`, `--status-failed`) kept **separate from the brand accents** as the brief requires. Motion tokens: `--ease-out-expo: cubic-bezier(0.22,1,0.36,1)` plus three durations. |
| `src/app/layout.tsx` | Add `Space_Grotesk` via `next/font/google` with a size-adjusted metric fallback; wire `--font-display`. Move Michroma to `--font-brand`. |
| `docs/design/tokens.md` | **New.** The deliverable from brief §6 — every token, its value, what it is for, and the rules (one gradient recipe; glow is a state, not decoration; status never borrows brand accents). Written so a dashboard author can adopt it without reading this plan. |
| `src/test/tokens.test.ts` | **New.** Programmatic contrast, per brief §5: parse the CSS, assert body text on `--bg-base` clears 4.5:1 and display text clears 3:1. This is the "verify programmatically, not by eye" requirement, and it fails the build if a token is later nudged out of compliance. |

Nothing visual changes in stage 1. The dashboard is unaffected — verified by
running the existing 83 tests plus a build.

### Stage 2 — nav and hero

| File | Change |
|---|---|
| `src/app/(marketing)/layout.tsx` | **New.** Route group: dark scope, full-bleed background, skip link, `<SiteNav>`, `<SiteFooter>`. |
| `src/app/page.tsx` | Moves to `src/app/(marketing)/page.tsx`. **URL unchanged** — route groups do not affect the path. Becomes a thin composition of section components; keeps `RedirectIfSignedIn`, both JSON-LD blocks and the full metadata export verbatim. |
| `src/app/pricing/page.tsx` → `(marketing)/pricing/` | Moves into the group so it inherits the nav. Path unchanged, metadata untouched. |
| `src/components/marketing/site-nav.tsx` | **New.** Sticky, transparent over hero, gains blur + hairline after 80px (one passive scroll listener, `requestAnimationFrame`-throttled). Mobile drawer reuses `useFocusTrap` + `useScrollLock`. |
| `src/components/marketing/hero.tsx` | **New.** Headline, subcopy, both CTAs, the four annotations. |
| `src/components/marketing/hero-visual.tsx` | **New.** Hub, orbit, flow lines, calendar cluster — per **D1**. Orbit reads `PLATFORM_MARKS`; independent 6–10s floats via staggered `animation-delay`; hover glow + tooltip. Flow lines are `stroke-dasharray` animations on `transform`/`opacity` only. Desktop-only parts are removed below 768px **by not rendering them**, not by `display:none`, so mobile does not pay for them. |
| `src/lib/use-in-view.ts` | **New.** ~25-line `IntersectionObserver` hook, fires once, disconnects. This is what replaces an animation library. |

The reduced-motion path is built in this stage, not bolted on: under
`prefers-reduced-motion: reduce` the hero renders as a complete static
composition — every element in its final position, no observer registered.

### Stage 3 — remaining sections

All new under `src/components/marketing/`: `connect-once.tsx`,
`how-it-works.tsx`, `feature-bento.tsx`, `findable.tsx`, `pricing-teaser.tsx`,
`faq.tsx` (accordion built on native `<details>`, so it works with JS off and is
keyboard-correct for free), `closing-cta.tsx`, `site-footer.tsx`.

`product-preview.tsx` is **reused, not replaced** — `CalendarPreview`,
`SeoPreview` and `ComposerPreview` become the bento's coded visuals. The score
dial's count-up on scroll-in uses `use-in-view` plus the existing
`use-eased-progress` idiom.

Copy sourcing, against brief §4:

- Hero copy: verbatim from the brief.
- Bento: the six existing `WHAT_IT_DOES` blocks, already vetted.
- How it works: the four steps map to real code — `content.py` (per-channel
  adaptation), `image.py` + `video.py` (generation), and `planner.py`, whose
  docstring says "preferred times, or **engagement-driven best times**". I
  checked this one specifically because "a schedule learned from your results"
  is the kind of claim that is usually aspirational. It is not.
- FAQ: the brief asks for five, of which three exist verbatim. The two new ones
  — *what happens to my accounts*, *what data does it use* — I will source from
  the already-vetted disclosure copy on `/integrations/tiktok` rather than write
  fresh claims about data handling.

**No social proof section exists**, per §4. No logo wall, no testimonials, no
company metrics. The 91 SEO score and the calendar chips stay, clearly framed as
product UI, and `product-preview.tsx` already carries the comment saying they are
illustrative.

### Stage 4 — polish and audit

- `src/test/marketing.test.tsx` — **new.** Every preserved destination from the
  inventory table above asserted by href; both JSON-LD blocks assert-parsed;
  `og:site_name` asserted present; axe clean on each section; accordion and
  drawer keyboard paths.
- `src/test/bundle.test.ts` — **new.** Asserts the landing route's first-load JS
  is under the 90KB gzipped budget and that **`framer-motion` is absent from its
  chunk graph**. A budget nobody measures is a wish.
- Reduced-motion, forced-colors and `prefers-reduced-transparency` passes — the
  last two because `globals.css` already handles them app-wide and new work
  should not be the exception.
- Widths 390 / 768 / 1024 / 1440 / 1920: no horizontal scroll, tap targets ≥44px.
- Gradient text ships a solid `color` before `background-clip: text` so it
  degrades legibly.

---

## 3. Deletions

**Nothing is deleted in this plan.** Everything moves or is reused:

- `page.tsx` and `pricing/page.tsx` **move** into the `(marketing)` group. Both
  URLs are unchanged.
- `product-preview.tsx`, `logo.tsx`, `ui.tsx`, `use-focus-trap.ts`,
  `use-scroll-lock.ts` — all reused as-is.
- No existing token is removed; the new names are added alongside and the old
  names alias onto the same ramp.

If stage 3 makes any part of `product-preview.tsx` genuinely dead I will name the
export and ask before removing it.

---

## 4. Risks I am tracking

1. **The 90KB budget is already blown at 115 kB before any work** — see the
   baseline in §0 and **D6**. Two compounding factors: the shared provider chunk
   (D6) and the hero (D1). A coded hub has room; a 180KB raster does not fit in
   a 90KB budget at all, which is worth noticing about the brief's own numbers.
   Measured in stage 4, never estimated.
2. **`backdrop-filter` on the nav.** The brief caps its use and `globals.css`
   already warns it is expensive. One sticky element only, and it stays behind
   the existing `prefers-reduced-transparency` fallback.
3. **Moving pages into a route group** changes no URL but does change build
   output paths. The metadata and sitemap tests are the check, and I will diff
   the built HTML for `og:site_name` and the canonical rather than trust it.
4. **Two SSR-sensitive things** — `new Date().getFullYear()` in the footer and
   the scroll listener — stay on the correct side of the server/client line.

---

## 5. What I need to start

Approve, or redirect, the six decisions in §1. Two of them change the shape of
the work; the other four I have a clear recommendation on and will proceed with
unless you say otherwise.

- **D1 — coded hub, or send me the mockups.** If you have the two JPGs, drop
  them in `docs/design/` and I will work from them regardless of how D1 lands,
  since they inform composition beyond the hub itself.
- **D6 — may I move the provider boundary?** This decides whether the 90KB
  target is reachable at all.

Default if you just say "go": D1 coded, D2 one ramp, D3 Space Grotesk +
Michroma kept for the wordmark, D4 route-group dark scope, D5 Integrations
instead of Docs, **D6 not done** — because it touches every route and I will not
assume consent for that. Tell me to do D6 and the budget comes with it.

---

## 6. As built

### Measured

| | Before | After |
|---|---|---|
| Landing route, first-load JS (gzipped) | 116.0 KB | **116.8 KB** |
| Landing page's own chunk | 1.6 KB | **5.6 KB** |
| Server-rendered words on `/` | ~640 | **1,299** |
| Web tests | 83 | **129** |
| Horizontal overflow at 390/768/1024/1440/1920 | — | **none** |
| Tap targets under 44px at those widths | — | **none** |

The whole redesign — nav, hero with an eight-channel orbit, seven sections, FAQ,
footer — costs **4.0 KB** on the route. The other 111 KB is the shared chunk from
**D6**, which was not taken. The brief's ~90KB is not met and could not be
without that change; `src/test/bundle.test.ts` states this in full and asserts
what the work does control.

### Changed from the plan

- **Reduced-motion is verified, not asserted by hand.** Under
  `prefers-reduced-motion: reduce`: 28 reveal elements, **0 still hidden, 0 still
  animating**, and the SEO dial renders its final `91` immediately. The trap
  avoided: the app-wide reduce block only flattens *durations*, which would have
  left every `.reveal` stuck at `opacity: 0` — a blank page for exactly the
  people who asked for less motion.
- **Desktop-only hero parts are hidden with CSS, not unmounted.** The plan said
  "not rendered". A `matchMedia` check has to run after hydration, which means
  either a server/client mismatch or a visible reflow on load. `display: none`
  also stops animations, so the runtime cost on a phone is nil and the markup
  cost is ~1KB of static SVG. The JS version would have been more code and worse.
- **`--text-muted` is `#7C82A0`, not the brief's `#6E7490`.** The suggested value
  measures **4.40:1** on `--bg-base` and fails WCAG 1.4.3 for body text — and the
  eyebrow style uses it at 0.75rem, so no large-text exemption applies. The
  adjusted value is 5.36:1. A test asserts the original stays rejected.
- **The pricing page lost its own header and footer**, which became duplicates
  once it inherited the marketing shell. Its featured CTA also moved to
  `.btn-brand`: `bg-accent text-white` measures **3.96:1** on the marketing
  palette.
- **Nav says Integrations, not Docs** (**D5**), and a test asserts the nav links
  only to routes that exist.

### Bugs this surfaced, all pre-existing

1. **`text-danger`, `border-token` and `text-muted` matched no token**, so
   Tailwind emitted **no rule at all** for them. They were live in the composer
   and in `tiktok-post-settings.tsx` — the panel currently under TikTok platform
   review had no border and rendered its error text in body colour. Fixed by the
   token layer.
2. **`PlatformGlyph` put `aria-label` on a bare `<span>`.** `aria-label` is
   *prohibited* on an element with no role, so screen readers ignored it and
   announced every platform mark as nothing. Affected the connections list, the
   composer and the calendar. Fixed with `role="img"`. Caught by the new axe gate.
3. **`PLATFORM_MARKS` could not cross the server/client boundary.** `ui.tsx` is
   `"use client"`, and a JSX value exported from a client module reaches a Server
   Component as a client reference — so the marks rendered as empty squares in
   any server component. Extracted to `platform-marks.tsx`, which carries no
   directive.
4. **Two contradictory comments on the brand marks** — one claiming "geometric
   renditions rather than the exact trademarked artwork", one claiming real
   Simple Icons paths. The second is correct. The stale one is gone, which
   matters because the brief requires real logos.
5. **`@testing-library/user-event` was never a declared dependency.** Three test
   files imported it while it sat in `node_modules` unlisted and absent from the
   lockfile. Now declared in `apps/web/package.json`. (My own failed `npm
   install` at the repo root is what pruned it and exposed this.)
6. **`@theme` needed to be `@theme inline`.** Documented at length in
   `tokens.md` — without it every semantic colour freezes at `:root` and the
   marketing palette silently does nothing.

### Still open, deliberately

- **D6 — the provider boundary.** The one route to the brief's budget. Not taken
  without sign-off; it changes every page in the product.
- **The legal pages are still light.** `/privacy`, `/terms` and `/data-deletion`
  live in the `(legal)` group with their own layout, so the footer links jump
  from a near-black marketing page to a white one. Adding `marketing` to that
  layout's wrapper would fix it in one line — the token aliases do the rest — but
  those pages are fetched by Meta and Google during review and were outside what
  was asked. Flagging rather than doing.
- **No `/docs` route.** If you want Docs in the nav, that is a separate piece of
  work.
