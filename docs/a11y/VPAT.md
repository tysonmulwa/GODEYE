# Accessibility Conformance Report — GODEYE

**VPAT® 2.5 format · WCAG 2.2 Level AA · EN 301 549**

| | |
|---|---|
| Product | GODEYE — AI Marketing Operating System (web application) |
| Version | `security/p0-remediation` |
| Report date | 2026-08-20 |
| Evaluation methods | Automated (axe-core 4.13 via vitest + jsdom), source review, and a partial keyboard pass |
| **Conformance claim** | **Partially Supports** |

---

## 🔴 Read this before quoting the table

**This report is not a completed VPAT.** A VPAT requires testing that this
repository cannot perform on its own:

- **No screen-reader pass has been done.** Not NVDA, not JAWS, not VoiceOver.
  Every "Supports" below that concerns announcement is inferred from correct
  ARIA in the markup, which is necessary and not sufficient.
- **No colour-contrast measurement has been done.** jsdom does not render, so
  axe cannot evaluate contrast in this setup. Criterion 1.4.3 is therefore
  **Not Evaluated**, not "Supports".
- **No real-browser keyboard pass.** Focus order and visible focus were tested
  in jsdom, which has no layout and no rendering.
- **Only three components are covered by automated tests.** The drawer, the live
  region and the skip link. Every page — dashboard, composer, calendar, SEO,
  billing, onboarding — is **untested**.

The honest summary: **the three gaps the audit named are fixed and pinned by
tests; the rest of the application has not been assessed.** Do not send this to
a customer as a conformance claim. It is an internal status report that happens
to use the VPAT layout, and it says so here so that nobody has to discover it.

---

## What was fixed

| Gap | Criterion | Status | Evidence |
|---|---|---|---|
| No focus trap on the mobile drawer | 2.1.2, 2.4.3 | **Fixed** | `use-focus-trap.ts`, 6 tests |
| No `aria-live` on polled status | 4.1.3 | **Fixed** | `live-status.tsx`, 5 tests |
| No skip link | 2.4.1 | **Fixed** | `layout.tsx`, 3 tests |
| Motion not reduced on request | 2.3.3 | **Fixed** | `globals.css`, `useReducedMotion` |
| Nothing survives forced colours | 1.4.11 | **Fixed** | `globals.css` `@media (forced-colors: active)` |
| No focus ring guarantee | 2.4.7 | **Fixed** | global `:focus-visible` |

Two things the fixes surfaced that were not in the audit:

1. **The closed drawer stayed in the tab order.** `translate-x-full` moves it
   off-screen and leaves every link focusable, so Tab appeared to do nothing
   several times in a row. Fixed with `inert`.
2. **The usual focus-trap idiom would not have worked here.** `offsetParent !==
   null` is the standard "is it visible" shorthand, and `offsetParent` is null
   for any `position: fixed` element — which the drawer is. It would have
   filtered out every link and trapped focus on the container. Caught by the
   first test written against it.

---

## Table 1 — Success Criteria, Level A

| Criterion | Level | Conformance | Remarks |
|---|---|---|---|
| 1.1.1 Non-text Content | A | Partially Supports | Icon-only buttons carry `aria-label`; decorative icons are `aria-hidden`. Generated media uses `alt=""`, which is wrong for content images — **open** |
| 1.2.x Time-based Media | A | Not Applicable | The product generates video for publishing elsewhere; it plays none as content |
| 1.3.1 Info and Relationships | A | Partially Supports | Semantic landmarks (`nav`, `main`, `aside`, `header`); the drawer is `role="dialog"` only while modal. Form-to-error association not verified |
| 1.3.2 Meaningful Sequence | A | Supports | DOM order matches visual order; no CSS reordering |
| 1.3.3 Sensory Characteristics | A | Supports | No instruction depends on shape or position alone |
| 1.4.1 Use of Color | A | **Not Evaluated** | Status badges may rely on fill alone. Needs a rendered check |
| 1.4.2 Audio Control | A | Not Applicable | Nothing auto-plays |
| 2.1.1 Keyboard | A | Partially Supports | All controls are native elements or have handlers. Not verified in a real browser |
| **2.1.2 No Keyboard Trap** | A | **Supports** | Focus cycles within the drawer and always exits via Escape. 6 tests |
| 2.1.4 Character Key Shortcuts | A | Supports | The command palette uses ⌘K/Ctrl+K, a modifier combination |
| 2.2.1 Timing Adjustable | A | Partially Supports | The 24-hour trial is a business limit, not a UI timeout. Session expiry refreshes silently |
| 2.2.2 Pause, Stop, Hide | A | Supports | Animations are short and non-looping; `prefers-reduced-motion` removes them |
| 2.3.1 Three Flashes | A | Supports | Nothing flashes |
| **2.4.1 Bypass Blocks** | A | **Supports** | Skip link, first in the tab order, targeting a focusable `<main>`. 3 tests |
| 2.4.2 Page Titled | A | Supports | `generateMetadata` per route |
| **2.4.3 Focus Order** | A | **Supports** | Focus enters the drawer on open and returns to the opener on close |
| 2.4.4 Link Purpose | A | Supports | Link text is self-describing |
| 2.5.1 Pointer Gestures | A | Supports | No path-based or multipoint gesture |
| 2.5.2 Pointer Cancellation | A | Supports | Actions fire on `click`, not `pointerdown` |
| 2.5.3 Label in Name | A | Partially Supports | Not systematically verified |
| 2.5.4 Motion Actuation | A | Not Applicable | No motion-actuated function |
| 3.1.1 Language of Page | A | Supports | `<html lang="en">` |
| 3.2.1 On Focus | A | Supports | Focus alone changes no context |
| 3.2.2 On Input | A | Supports | No form auto-submits on change |
| 3.2.6 Consistent Help | A | Partially Supports | Help is not in a consistent location across pages — **open** |
| 3.3.1 Error Identification | A | Partially Supports | Errors are shown in text; `aria-describedby` association not verified |
| 3.3.2 Labels or Instructions | A | Supports | Every field has a `<Label>` |
| 3.3.7 Redundant Entry | A | Supports | Onboarding carries values forward |
| 4.1.2 Name, Role, Value | A | Partially Supports | Custom controls carry ARIA; only the three tested components are verified |
| **4.1.3 Status Messages** | AA¹ | **Supports** | Polite live regions on generation and rendering; assertive for failures. 5 tests |

¹ 4.1.3 is Level AA; listed here beside the criteria it relates to.

## Table 2 — Success Criteria, Level AA

| Criterion | Conformance | Remarks |
|---|---|---|
| 1.2.4 Captions (Live) | Not Applicable | No live media |
| 1.3.4 Orientation | Supports | Responsive; no orientation lock |
| 1.3.5 Identify Input Purpose | Partially Supports | `autocomplete` on auth fields; **absent elsewhere** — open |
| **1.4.3 Contrast (Minimum)** | **Not Evaluated** | jsdom does not render, so axe cannot measure it. Requires a real-browser pass |
| 1.4.4 Resize Text | Partially Supports | `rem`-based type; not verified at 200% |
| 1.4.5 Images of Text | Supports | None |
| 1.4.10 Reflow | Supports | Responsive to 320px; `min-w-0` prevents horizontal scroll |
| **1.4.11 Non-text Contrast** | Partially Supports | Forced-colors handled; custom-property borders unmeasured |
| 1.4.12 Text Spacing | Not Evaluated | Not tested with a spacing override |
| 1.4.13 Content on Hover | Partially Supports | Tooltips are not verified dismissible/hoverable/persistent |
| 2.4.5 Multiple Ways | Supports | Navigation plus the ⌘K command palette |
| 2.4.6 Headings and Labels | Supports | Descriptive throughout |
| **2.4.7 Focus Visible** | **Supports** | Global `:focus-visible` ring; `Highlight` under forced colours |
| 2.4.11 Focus Not Obscured | Partially Supports | Sticky header could obscure a focused element on a phone — **needs a real check** |
| 2.5.7 Dragging Movements | Supports | The calendar has no drag-only action |
| 2.5.8 Target Size (Minimum) | Partially Supports | Most targets meet 24×24; icon buttons at `p-1.5` are borderline — **measure** |
| 3.1.2 Language of Parts | Not Applicable | Single language |
| 3.2.3 Consistent Navigation | Supports | Same nav, same order, every page |
| 3.2.4 Consistent Identification | Supports | Consistent iconography and labels |
| 3.3.3 Error Suggestion | Partially Supports | Password rules are stated; other fields vary |
| 3.3.4 Error Prevention | Supports | Billing confirms before charging; destructive actions confirm |
| 3.3.8 Accessible Authentication | Supports | Password managers work; TOTP is pasteable; no cognitive-function test |

---

## Testing

```bash
pnpm --filter web test        # 17 assertions, axe-core on 3 components
```

Wired into CI, so a regression fails the build rather than being noticed later.

### What automated testing cannot reach

axe catches roughly 30–40% of WCAG issues in the best case, and in **jsdom** it
catches less, because there is no rendering: no contrast, no focus-ring
visibility, no reflow, no target size. The following require a person:

- [ ] NVDA + Firefox — full task pass (sign in, generate, schedule, publish)
- [ ] VoiceOver + Safari — same
- [ ] Keyboard-only, real browser — every page, no mouse
- [ ] 200% zoom, and 320px width
- [ ] Windows High Contrast Mode — verify the forced-colors block actually works
- [ ] Contrast measurement across both themes
- [ ] Target-size measurement on the icon buttons

Until that list is done, the conformance claim above is **Partially Supports**
and cannot honestly be anything else.

## Feedback

Accessibility problems: **accessibility@godeyeautomation.com**. We aim to
respond within five working days.
