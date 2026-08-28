# GODEYE design tokens

The token layer that the marketing pages are built from, written so the app
dashboard can adopt it without a restyle.

Everything lives in `apps/web/src/app/globals.css`. There is no
`tailwind.config.js` — Tailwind 4 is configured from the `@theme` block in that
file. Contrast is verified by `apps/web/src/test/tokens.test.ts`, which parses
this same CSS; a token nudged without re-checking its contrast fails the build.

---

## The one rule

**Components use semantic names. Never a raw hex, never a raw `rgb()`.**

```tsx
<p className="text-secondary">        {/* yes */}
<p className="text-[#A9AEC4]">        {/* no  */}
```

If a colour you need has no name, the answer is to name it here, not to inline
it. A hex in a component is invisible to the contrast test and to every future
theme.

---

## Adopting this in the dashboard

The layer was added by **aliasing, not by recolouring**. Every new name resolves
to a value the app already used:

| New name | Utility | Was |
|---|---|---|
| `--bg-base` | `bg-base` | `--surface` |
| `--bg-raised` | `bg-raised` | `--surface-2` |
| `--bg-elevated` | `bg-elevated` | `--surface-3` |
| `--text-primary` | `text-primary` | `--ink` |
| `--text-secondary` | `text-secondary` | `--ink-2` |
| `--text-muted` | `text-muted` | `--ink-3` |
| `--border-subtle` | `border-subtle` | `--line` |
| `--border-strong` | `border-strong` | `--line-hover` |

So adopting the new names in an app screen is a **rename with no visual change**.
`--surface` and `--ink` still work and still resolve to the same colours; nothing
was removed.

`:root` (light) and `.dark` keep the exact values they had. **The `.dark` block
was deliberately left untouched** — restyling every dashboard screen as a side
effect of a marketing redesign is not a thing anybody asked for. The dark values
below apply only inside `.marketing`.

### Utilities that were being used but did not exist

`text-danger` and `border-token` appeared in `composer/page.tsx` and
`tiktok-post-settings.tsx` while matching no token, so Tailwind emitted **no rule
at all** — the TikTok settings panel had no border and its error text rendered in
body colour. `--color-danger` and `--color-token` now exist, so those classes do
what they always read as doing.

---

## Colour

### The marketing palette (`.marketing` scope)

Dark-first. Deep near-black with a blue cast — not pure `#000`, because on pure
black every raised surface reads as a grey card floating in a void rather than as
depth.

| Token | Value | On `--bg-base` | Use |
|---|---|---|---|
| `--bg-base` | `#05060B` | — | Page canvas |
| `--bg-raised` | `#0B0D16` | — | Cards, panels |
| `--bg-elevated` | `#12141F` | — | Chips, controls, nested surfaces |
| `--border-subtle` | `rgb(255 255 255 / 0.08)` | — | Default hairline |
| `--border-strong` | `rgb(255 255 255 / 0.14)` | — | Hover, active, emphasis |
| `--text-primary` | `#F4F5FA` | **18.59:1** | Headings, body |
| `--text-secondary` | `#A9AEC4` | **9.20:1** | Supporting prose |
| `--text-muted` | `#7C82A0` | **5.36:1** | Eyebrows, captions, labels |

> **`--text-muted` is not the value the brief suggested.** `#6E7490` measures
> **4.40:1**, which fails WCAG 1.4.3 for body text — and the eyebrow style uses
> this colour at 0.75rem, so no large-text exemption applies. `#7C82A0` is the
> same hue, two steps lighter, at 5.36:1. There is a test asserting the original
> value stays rejected, because "restoring" it is an easy and silent regression.

### Accents

| Token | Value | On `--bg-base` | Use |
|---|---|---|---|
| `--accent-violet` | `#7C6BF7` | 5.11:1 | Primary CTA, active state, focus |
| `--accent-lilac` | `#A78BFA` | 7.44:1 | Gradient start, gradient-text fallback |
| `--accent-cyan` | `#22D3EE` | 11.20:1 | Gradient end, live/data highlights |
| `--accent-magenta` | `#E940A6` | 5.54:1 | Accents only — **never body text** |

Magenta's restriction is a **discipline rule, not a contrast one**: it measures
5.54:1 and would pass. Four accent colours in running text is what makes a page
look like a template.

### Status — never the brand accents

| Token | Value | Meaning |
|---|---|---|
| `--status-published` | `#34D399` | Published |
| `--status-scheduled` | `#FBBF24` | Scheduled |
| `--status-failed` | `#F87171` | Failed |

These are separate from the accents on purpose, and a test enforces it. If
"published" and the primary CTA are the same violet, the colour has stopped
carrying either meaning. All three clear 4.5:1 on **both** `--bg-base` and
`--bg-raised`, because status text appears inside cards as well as on the canvas.

### Gradient and glow

```css
--brand-gradient: linear-gradient(100deg, #A78BFA 0%, #7C6BF7 45%, #22D3EE 100%);
--glow-violet:    0 0 48px -10px rgb(124 107 247 / 0.55);
--glow-cyan:      0 0 48px -10px rgb(34 211 238 / 0.45);
```

**Exactly one gradient recipe**, defined once and reused. A test asserts
`--brand-gradient` is declared exactly once, so a second recipe has to be added
deliberately rather than by copy-paste.

**Glow is a state, not decoration.** It marks the primary CTA, the active node,
and the live data element — nothing else. On more than those it stops meaning
anything and starts meaning "this page has effects on it".

---

## Typography

Space Grotesk for display, Inter for body. Both are downloaded at build time by
`next/font/google` and served from this origin — that is why `fonts.gstatic.com`
is deliberately absent from `font-src` in `lib/csp.ts`. `adjustFontFallback`
synthesises a size-adjusted local fallback from each face's metrics, so the swap
does not move text and CLS stays near zero.

Michroma is still loaded, now as `--font-brand`, and is used **only** for the
wordmark. It is a wide decorative grotesk: right for a logo, unreadable as a
4.5rem sentence.

| Utility | Size | Line height | Tracking |
|---|---|---|---|
| `text-display-xl` | `clamp(2.75rem, 6vw, 4.5rem)` | 1.03 | −0.03em |
| `text-display-lg` | `clamp(2rem, 4vw, 3rem)` | 1.08 | −0.02em |
| `text-heading` | `1.5rem` | 1.2 | −0.01em |
| `text-body-lg` | `1.125rem` | 1.6 | — |
| `text-body` | `1rem` | 1.65 | — |
| `text-eyebrow` | `0.75rem` | 1 | 0.16em |

Tailwind 4 reads `--text-{name}--line-height` and `--text-{name}--letter-spacing`
off the same name, so `text-display-xl` carries all three. A caller cannot apply
the size and forget the tracking — which is the usual way a display scale drifts.

`eyebrow` is a size, not a colour. Pair it with `uppercase text-muted`.

---

## Space and elevation

4px base scale (Tailwind's default). Section rhythm:

```
py-[clamp(5rem,10vw,9rem)]   section vertical padding
max-w-[1200px]               content
max-w-[1440px]               hero visual, allowed to bleed
px-6                         24px gutters on mobile
```

**Elevation is a 1px hairline plus a lit top edge — never a drop shadow.** Use
the `.hairline` utility:

```css
border: 1px solid var(--border-subtle);
box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
```

A drop shadow on a near-black canvas has nothing to darken; it reads as mud
around the element. The inset highlight is what makes a panel look like it is
standing slightly off the page.

---

## Motion

```css
--ease-out-expo: cubic-bezier(0.22, 1, 0.36, 1);
--dur-fast: 180ms;   --dur-mid: 280ms;   --dur-slow: 420ms;
```

- Animate **`transform` and `opacity` only.** Anything else is a layout or paint
  on every frame.
- Entrances fire **once** on scroll-into-view via `use-in-view.ts`
  (`IntersectionObserver`, disconnects after firing). Never on a loop.
- There is **no animation library on the marketing route.** `framer-motion` is a
  dependency of the dashboard; a test asserts it is absent from the landing
  route's chunk graph.

### Reduced motion

`prefers-reduced-motion: reduce` is honoured completely, and this is the part
that is easy to get wrong. The global reduce block flattens durations — but on
its own that would leave every `.reveal` element stuck at `opacity: 0`, giving a
**blank page to exactly the people who asked for less motion.**

So the marketing block forces the end state on instead:

```css
@media (prefers-reduced-motion: reduce) {
  .reveal { opacity: 1; transform: none; transition: none; }
  .orbit-float, .flow-dash { animation: none; }
}
```

The hero renders as a complete static composition, every element in its final
position, and no observer is registered at all.

---

## Why marketing does not use `.dark`

The app is light by default and adds `.dark` to `<html>` from a `useEffect` in
`theme-toggle.tsx`. That is a poor foundation for a dark marketing page twice
over: the class lands *after* first paint, so the page would flash white on every
cold load, and it would invert entirely for any visitor who had set the dashboard
to light.

So marketing pages carry their own palette on their own wrapper — `.marketing`,
applied by `app/(marketing)/layout.tsx` — and never consult `.dark`. There is no
theme switch on marketing.

One consequence worth knowing about: `.marketing` restates the **old** aliases
(`--surface`, `--ink`, `--line`) as well as the new names. It has to.
`--surface: var(--bg-base)` is substituted where it is *declared*, at `:root`, so
a descendant that redefines `--bg-base` does **not** drag `--surface` along with
it. Without the restatement, any dashboard component reused on a marketing page —
the product previews are — would render with light-theme surfaces on a near-black
page.

---

## `@theme inline` is load-bearing

**If you take one thing from this document, take this one.** The theme block is
declared `@theme inline`, and it must stay that way.

Without `inline`, Tailwind emits the alias into `:root` and resolves the `var()`
*there*:

```css
:root { --color-primary: var(--text-primary); }   /* frozen at :root's value */
.text-primary { color: var(--color-primary); }
```

`.dark` gets away with this because it sits on `<html>` — the same element as
`:root` — so the cascade picks the winning value on that one element. **Any
scope on a descendant does not.** `.marketing` is a `<div>`, so every semantic
colour stayed frozen on its light value and the hero headline rendered `#101319`
on a near-black page. Invisible. It looked like a bug in the marketing palette
and was actually a substitution rule two files away.

With `inline`, Tailwind emits the utility referencing the token directly:

```css
.text-primary { color: var(--text-primary); }     /* resolves per element */
```

which follows any scope that redefines it, at any depth.

The practical rule: **a token layer that is meant to be re-scoped anywhere other
than `<html>` must be `@theme inline`.** Removing `inline` will not fail a build
or a test — it will silently return the marketing pages to light-on-dark text.

### One naming hazard

`--text-*` is Tailwind's **font-size** namespace. `--text-primary`,
`--text-secondary` and `--text-muted` are safe today only because they are
declared in `:root`, not inside `@theme`. Moving one of them into the theme block
would make `text-muted` resolve to a font size instead of a colour. If those
names ever need to be theme entries, rename them first.
