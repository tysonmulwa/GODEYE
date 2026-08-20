/**
 * The content security policy, asserted directive by directive.
 *
 * A CSP is a single long string, which is why they are so often subtly wrong:
 * a missing scheme, a stray `'unsafe-inline'` that survives into production, a
 * `connect-src` that forgot WebSocket. None of those look like anything in a
 * diff, and all of them are either a broken product or a policy that protects
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { baselinePolicy, fullPolicy, securityHeaders } from "../lib/csp";

const BASE = { nonce: "TESTNONCE1234567890==", apiUrl: "https://api.godeyeautomation.com" };
const prod = { ...BASE, isDev: false };
const dev = { ...BASE, isDev: true, apiUrl: "http://localhost:4000" };

/** Pulls one directive out of a policy string, so assertions can be exact. */
function directive(policy: string, name: string): string | undefined {
  return policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe("baselinePolicy", () => {
  /**
   * The baseline enforces from the first deploy, so every directive in it must
   * be one that cannot break a working page. If something is added here that
   * can, this test is the place it should have been argued about.
   */
  it("contains only directives with no failure mode for this app", () => {
    expect(baselinePolicy().split(";").map((d) => d.trim()).sort()).toEqual([
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]);
  });

  /**
   * script-src must NOT be in the baseline, and this is the assertion that
   * says why. Every page in this app prerenders, and a prerendered page's
   * script tags carry no nonce — measured on the build output: pricing.html
   * has 14 inline `self.__next_f.push(...)` blocks and 0 nonces. Adding
   * script-src to the always-enforcing set would blank every static page.
   */
  it("leaves script-src out, because static pages have no nonce to offer", () => {
    expect(baselinePolicy()).not.toContain("script-src");
    expect(baselinePolicy()).not.toContain("nonce");
  });

  it("denies framing outright", () => {
    // Clickjacking on the billing page: an invisible frame over a bait button
    // and the "upgrade" click belongs to the attacker.
    expect(directive(baselinePolicy(), "frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});

describe("fullPolicy", () => {
  it("nonces scripts and uses strict-dynamic", () => {
    const script = directive(fullPolicy(prod), "script-src")!;
    expect(script).toContain(`'nonce-${BASE.nonce}'`);
    expect(script).toContain("'strict-dynamic'");
  });

  /**
   * The one that matters most. `'unsafe-inline'` in script-src disables the
   * entire policy as an XSS defence, and it is the single most common thing to
   * find in a real CSP — usually added to fix one widget and never removed.
   */
  it("never allows inline script", () => {
    expect(directive(fullPolicy(prod), "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(fullPolicy(dev), "script-src")).not.toContain("'unsafe-inline'");
  });

  /** 'unsafe-eval' is React Refresh's requirement and must never ship. */
  it("allows eval in development and not in production", () => {
    expect(directive(fullPolicy(dev), "script-src")).toContain("'unsafe-eval'");
    expect(directive(fullPolicy(prod), "script-src")).not.toContain("'unsafe-eval'");
  });

  it("allows inline style, and says so", () => {
    // Deliberate: next/font injects a <style> block and framer-motion writes
    // style attributes. A stylesheet cannot execute.
    expect(directive(fullPolicy(prod), "style-src")).toContain("'unsafe-inline'");
  });

  describe("connect-src", () => {
    it("allows the API over https and wss", () => {
      const connect = directive(fullPolicy(prod), "connect-src")!;
      expect(connect).toContain("https://api.godeyeautomation.com");
      // Socket.IO opens with polling and upgrades. Without wss the realtime
      // channel silently degrades to long-polling forever, which looks like
      // "the app is a bit slow" rather than like a broken policy.
      expect(connect).toContain("wss://api.godeyeautomation.com");
    });

    it("uses ws for a plain-http API", () => {
      expect(directive(fullPolicy(dev), "connect-src")).toContain("ws://localhost:4000");
    });

    /**
     * A malformed NEXT_PUBLIC_API_URL must not yield a policy with an empty
     * token in it. `connect-src 'self' ` reads as a normal policy and allows
     * nothing, and the app then fails in a way no header inspection explains.
     */
    it("degrades to 'self' rather than emitting an empty token", () => {
      const policy = fullPolicy({ ...prod, apiUrl: "not a url" });
      expect(directive(policy, "connect-src")).toBe("connect-src 'self' 'self' 'self'");
      expect(policy).not.toMatch(/;\s*;/);
    });
  });

  it("does not allow framing anything, since every provider is a redirect", () => {
    expect(directive(fullPolicy(prod), "frame-src")).toBe("frame-src 'none'");
  });

  it("keeps fonts local, because next/font self-hosts at build time", () => {
    const font = directive(fullPolicy(prod), "font-src")!;
    expect(font).not.toContain("fonts.gstatic.com");
    expect(font).toContain("'self'");
  });

  it("upgrades insecure requests only outside development", () => {
    expect(fullPolicy(prod)).toContain("upgrade-insecure-requests");
    // Would rewrite every localhost asset request to https and break the dev
    // server outright.
    expect(fullPolicy(dev)).not.toContain("upgrade-insecure-requests");
  });

  it("carries the whole baseline", () => {
    for (const d of baselinePolicy().split(";").map((s) => s.trim())) {
      expect(fullPolicy(prod)).toContain(d);
    }
  });

  it("emits no empty directives", () => {
    expect(fullPolicy(prod)).not.toMatch(/;\s*;/);
    expect(fullPolicy(prod).trim().endsWith(";")).toBe(false);
  });
});

describe("securityHeaders", () => {
  it("reports rather than enforces the full policy until told otherwise", () => {
    const headers = securityHeaders({ ...prod, enforce: false });
    // The baseline is still a rule — it has nothing to dry-run.
    expect(headers["Content-Security-Policy"]).toBe(baselinePolicy());
    expect(headers["Content-Security-Policy-Report-Only"]).toBe(fullPolicy(prod));
  });

  it("promotes the full policy when enforcement is on", () => {
    const headers = securityHeaders({ ...prod, enforce: true });
    expect(headers["Content-Security-Policy"]).toBe(fullPolicy(prod));
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });

  it("keeps frame-ancestors enforcing in both modes", () => {
    for (const enforce of [true, false]) {
      const headers = securityHeaders({ ...prod, enforce });
      expect(directive(headers["Content-Security-Policy"], "frame-ancestors")).toBe(
        "frame-ancestors 'none'",
      );
    }
  });

  /**
   * The OAuth callback URL carries `state` and `code` in its query string.
   * Under the browser default those would travel onward in a Referer header to
   * anything the callback page links to — the leak path finding C-1 turned on.
   */
  it("does not leak query strings across origins", () => {
    expect(securityHeaders({ ...prod, enforce: true })["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("blocks MIME sniffing, which matters because customers upload files", () => {
    expect(securityHeaders({ ...prod, enforce: true })["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("sends X-Frame-Options for browsers that never learned CSP3", () => {
    expect(securityHeaders({ ...prod, enforce: true })["X-Frame-Options"]).toBe("DENY");
  });

  it("denies the device permissions nothing in the product asks for", () => {
    const policy = securityHeaders({ ...prod, enforce: true })["Permissions-Policy"];
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  describe("HSTS", () => {
    it("is sent in production", () => {
      expect(securityHeaders({ ...prod, enforce: true })["Strict-Transport-Security"]).toContain(
        "max-age=31536000",
      );
    });

    /**
     * Never in development. A browser that has been told localhost is
     * https-only stays that way for a year, and no server-side change undoes
     * it — the developer has to clear it by hand.
     */
    it("is not sent in development", () => {
      expect(
        securityHeaders({ ...dev, enforce: false })["Strict-Transport-Security"],
      ).toBeUndefined();
    });

    /** `preload` is slow to reverse and is not this change's call to make. */
    it("does not claim preload", () => {
      expect(securityHeaders({ ...prod, enforce: true })["Strict-Transport-Security"]).not.toContain(
        "preload",
      );
    });
  });
});
