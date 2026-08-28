/**
 * The design token layer, checked by measurement rather than by eye.
 *
 * WCAG 1.4.3 Contrast (Minimum) is a number, and "it looks fine on my screen"
 * is how a palette ships at 4.4:1. The brief's own suggested --text-muted was
 * #6E7490, which measures 4.40:1 against --bg-base and fails for body text —
 * caught here, not in review. That is the entire reason this file exists.
 *
 * These read the real globals.css. A token nudged in that file without
 * re-checking its contrast fails the build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

/** The declarations inside one top-level selector block. */
function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in globals.css`);
  const end = CSS.indexOf("\n}", start);
  const body = CSS.slice(start, end);
  const out: Record<string, string> = {};
  // Keyed without the leading `--`, so lookups read block(".marketing")["bg-base"].
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const marketing = block(".marketing");
const root = block(":root");

// --- WCAG 2.1 relative luminance and contrast ------------------------------

function channel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return (
    0.2126 * channel(((n >> 16) & 255) / 255) +
    0.7152 * channel(((n >> 8) & 255) / 255) +
    0.0722 * channel((n & 255) / 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("contrast · WCAG 1.4.3", () => {
  const bg = marketing["bg-base"];

  it("has a near-black base with a blue cast rather than pure black", () => {
    // Pure #000 makes every surface above it look like a grey card floating in
    // a void; the blue cast is what makes the elevation ramp read as depth.
    expect(bg).toBe("#05060b");
  });

  /**
   * 4.5:1 is the body-text bar, and --text-muted is used at 0.75rem by the
   * eyebrow style — small text, so no large-text exemption applies to it.
   */
  it.each([
    ["--text-primary", "text-primary"],
    ["--text-secondary", "text-secondary"],
    ["--text-muted", "text-muted"],
  ])("%s clears 4.5:1 on --bg-base", (_label, key) => {
    expect(contrast(marketing[key], bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the adjusted --text-muted, not the brief's original", () => {
    // Guards the specific regression: someone "restoring" the brief's value.
    expect(contrast("#6e7490", bg)).toBeLessThan(4.5);
    expect(marketing["text-muted"]).not.toBe("#6e7490");
  });

  /** 3:1 is the large-text bar; display text is the only thing allowed it. */
  it.each([
    ["--accent-violet", "accent-violet"],
    ["--accent-lilac", "accent-lilac"],
    ["--accent-cyan", "accent-cyan"],
  ])("%s clears 3:1 on --bg-base for display use", (_label, key) => {
    expect(contrast(marketing[key], bg)).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["published", "status-published"],
    ["scheduled", "status-scheduled"],
    ["failed", "status-failed"],
  ])("status %s is legible on both --bg-base and --bg-raised", (_label, key) => {
    expect(contrast(marketing[key], marketing["bg-base"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(marketing[key], marketing["bg-raised"])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the rules the palette is supposed to hold to", () => {
  /**
   * Brief: "exactly one gradient recipe reused everywhere". Defined once, in
   * :root, so every use is the same declaration and a second recipe has to be
   * added deliberately rather than by copy-paste.
   */
  it("defines exactly one brand gradient", () => {
    expect(CSS.match(/--brand-gradient:/g)).toHaveLength(1);
    expect(root["brand-gradient"]).toContain("linear-gradient(100deg");
  });

  /**
   * Status must not borrow the brand accents. If "published" and the primary
   * CTA are the same violet, the colour has stopped carrying either meaning.
   */
  it("keeps status colours disjoint from the brand accents", () => {
    const accents = ["accent-violet", "accent-lilac", "accent-cyan", "accent-magenta"].map(
      (k) => marketing[k].toLowerCase(),
    );
    for (const k of ["status-published", "status-scheduled", "status-failed"]) {
      expect(accents).not.toContain(marketing[k].toLowerCase());
    }
  });

  /**
   * Elevation is a hairline plus a lit top edge, never a drop shadow: on a
   * near-black canvas a shadow has nothing to darken and reads as mud.
   */
  it("separates surfaces with a border and an inset highlight", () => {
    expect(block(".hairline")).toBeTruthy();
    const h = CSS.slice(CSS.indexOf(".hairline {"), CSS.indexOf(".hairline {") + 260);
    expect(h).toContain("inset 0 1px 0");
    expect(h).not.toMatch(/box-shadow:\s*0 \d/);
  });

  it("gives the elevation ramp three distinct steps", () => {
    const steps = ["bg-base", "bg-raised", "bg-elevated"].map((k) => luminance(marketing[k]));
    expect(steps[0]).toBeLessThan(steps[1]);
    expect(steps[1]).toBeLessThan(steps[2]);
  });

  /**
   * Gradient text sets `color` before painting over it, so it degrades to a
   * legible solid rather than transparent-on-transparent where
   * background-clip: text does not apply.
   */
  it("gives gradient text a solid colour fallback first", () => {
    const start = CSS.indexOf(".text-gradient {");
    const rule = CSS.slice(start, CSS.indexOf("}", start));
    expect(rule.indexOf("color:")).toBeLessThan(rule.indexOf("background-clip"));
    expect(rule).toContain("var(--accent-lilac)");
  });
});

describe("the app theme is left alone", () => {
  /**
   * The whole point of D2: the dashboard gets new NAMES, not new colours.
   * Changing .dark here would restyle every app screen as a side effect of a
   * marketing redesign, which is not a thing anybody asked for.
   */
  it("does not redefine the dark app palette", () => {
    const dark = block(".dark");
    expect(dark["surface"]).toBe("#000000");
    expect(dark["ink"]).toBe("#f4f5f7");
  });

  it("keeps the light aliases pointing at the values the app already used", () => {
    expect(root["bg-base"]).toBe("#f6f7f9");
    expect(root["text-primary"]).toBe("#101319");
    expect(root["border-subtle"]).toBe("#e4e7ec");
  });

  /**
   * `text-danger` and `border-token` were live in the composer and in the
   * TikTok settings panel while matching no token at all, so Tailwind emitted
   * no rule: the panel under platform review had no border and its error text
   * rendered in body colour.
   */
  it("defines the utilities the app was already using", () => {
    for (const name of ["--color-muted", "--color-danger", "--color-token"]) {
      expect(CSS).toContain(`${name}:`);
    }
  });
});
