/**
 * The CSRF decision, as a table (S-14).
 *
 * The exploit suite proves the guard is wired in and that a real browser
 * request is refused. This proves the decision itself is right at the edges —
 * the substring bugs, the case bugs and the empty-value bugs that make an
 * origin check look like it works while allowing exactly the thing it exists
 * to stop.
 */
import { decideCsrf } from "./csrf.guard";
import { toOrigin } from "./env";

const ALLOWED = ["https://godeyeautomation.com", "http://localhost:3000"];

const decide = (over: Partial<Parameters<typeof decideCsrf>[0]>) =>
  decideCsrf({ method: "POST", exempt: false, allowed: ALLOWED, ...over });

describe("decideCsrf", () => {
  describe("methods that change nothing", () => {
    it.each(["GET", "HEAD", "OPTIONS", "get", "options"])("allows %s", (method) => {
      expect(decide({ method, origin: "https://evil.example.com" })).toEqual({
        allow: true,
        because: "safe-method",
      });
    });

    // The OAuth callbacks are GETs arriving from Meta, TikTok, LinkedIn and
    // Reddit. Gating safe methods would break every connect flow in the
    // product, which is how a CSRF defence gets reverted wholesale.
    it("allows a GET from a platform that is not on the list", () => {
      expect(decide({ method: "GET", origin: "https://www.facebook.com" }).allow).toBe(true);
    });
  });

  describe("state-changing requests", () => {
    it("allows the configured web app", () => {
      expect(decide({ origin: "https://godeyeautomation.com" })).toEqual({
        allow: true,
        because: "origin-allowed",
      });
    });

    it("refuses another site", () => {
      expect(decide({ origin: "https://evil.example.com" })).toEqual({
        allow: false,
        because: "foreign-origin",
        origin: "https://evil.example.com",
      });
    });

    /**
     * Fail closed. The tempting reading is "no Origin means same-origin, which
     * is safe" — it does not: a non-browser client sends none, and so do some
     * redirect chains. "Cannot tell" is not "safe".
     */
    it("refuses a request carrying neither Origin nor Referer", () => {
      expect(decide({})).toEqual({ allow: false, because: "no-origin", origin: null });
    });

    it("refuses an empty Origin", () => {
      expect(decide({ origin: "" }).allow).toBe(false);
    });

    /** Sandboxed iframes and some cross-origin redirects send the literal string. */
    it("refuses the opaque origin", () => {
      expect(decide({ origin: "null" }).allow).toBe(false);
    });
  });

  describe("origins that look close enough and are not", () => {
    it.each([
      ["a sibling subdomain", "https://evil.godeyeautomation.com"],
      ["a suffix", "https://godeyeautomation.com.evil.example.com"],
      ["a prefix", "https://notgodeyeautomation.com"],
      ["the wrong scheme", "http://godeyeautomation.com"],
      ["the wrong port", "http://localhost:3001"],
      ["a userinfo trick", "https://godeyeautomation.com@evil.example.com"],
    ])("refuses %s", (_label, origin) => {
      expect(decide({ origin }).allow).toBe(false);
    });

    /**
     * `https://godeyeautomation.com:443` and `https://godeyeautomation.com` are
     * the same origin, and the URL parser drops the default port for us — so
     * this is allowed, and it is allowed for a reason rather than by accident.
     */
    it("allows the explicit default port, which is the same origin", () => {
      expect(decide({ origin: "https://godeyeautomation.com:443" }).allow).toBe(true);
    });
  });

  describe("Referer fallback", () => {
    /**
     * Referer carries a full URL, not an origin, so it must be reduced to one.
     * Comparing the raw header would reject every real request, since a browser
     * sends the page path with it.
     */
    it("accepts a Referer on an allowed origin, path and all", () => {
      expect(decide({ referer: "https://godeyeautomation.com/dashboard?tab=1" })).toEqual({
        allow: true,
        because: "origin-allowed",
      });
    });

    it("refuses a Referer from elsewhere", () => {
      expect(decide({ referer: "https://evil.example.com/attack.html" }).allow).toBe(false);
    });

    /** Origin decides when both are present; it is the narrower statement. */
    it("prefers Origin over Referer", () => {
      expect(
        decide({
          origin: "https://evil.example.com",
          referer: "https://godeyeautomation.com/dashboard",
        }).allow,
      ).toBe(false);
    });
  });

  describe("bearer tokens", () => {
    it("allows a bearer-authenticated request with no Origin", () => {
      expect(decide({ authorization: "Bearer eyJhbGciOi" })).toEqual({
        allow: true,
        because: "bearer",
      });
    });

    it("accepts the header in any case, as HTTP requires", () => {
      expect(decide({ authorization: "bearer eyJhbGciOi" }).allow).toBe(true);
    });

    /**
     * The word alone is not a token. Without this an attacker's form could set
     * nothing at all and a naive `startsWith("Bearer")` on an absent header's
     * "" would still... not match — but `"Bearer "` with an empty token would,
     * and that is a free bypass of the whole guard.
     */
    it("refuses the word Bearer with no token after it", () => {
      expect(decide({ authorization: "Bearer " }).allow).toBe(false);
      expect(decide({ authorization: "Bearer" }).allow).toBe(false);
    });

    it("does not treat Basic auth as a bearer", () => {
      expect(decide({ authorization: "Basic dXNlcjpwYXNz" }).allow).toBe(false);
    });
  });

  describe("exemptions", () => {
    it("allows an exempt route with no Origin", () => {
      expect(decide({ exempt: true })).toEqual({ allow: true, because: "exempt" });
    });

    /**
     * An exemption is unconditional by design — a webhook provider will never
     * send an Origin, so a partial exemption would be a webhook that works
     * until the provider changes something.
     */
    it("allows an exempt route even from a foreign origin", () => {
      expect(decide({ exempt: true, origin: "https://evil.example.com" }).allow).toBe(true);
    });
  });

  /**
   * An empty allow-list denies everything rather than allowing everything.
   * `[].includes(x)` is false, which is the right answer here and is worth
   * pinning: the mirror-image bug, where a misconfigured list means "allow
   * all", is one of the most common ways an origin check is silently disabled.
   */
  it("denies every state-changing request when the allow-list is empty", () => {
    expect(
      decideCsrf({
        method: "POST",
        exempt: false,
        allowed: [],
        origin: "https://godeyeautomation.com",
      }).allow,
    ).toBe(false);
  });
});

describe("toOrigin", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    ["https://app.example.com/", "https://app.example.com"],
    ["https://app.example.com/deep/path?q=1#f", "https://app.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://app.example.com:8443/x", "https://app.example.com:8443"],
  ])("reduces %s to %s", (input, expected) => {
    expect(toOrigin(input)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["the opaque origin", "null"],
    ["a bare host", "godeyeautomation.com"],
    ["nonsense", "!!!"],
  ])("returns null for %s", (_label, input) => {
    expect(toOrigin(input)).toBeNull();
  });

  /**
   * `javascript:` and `data:` parse as valid URLs. Without the scheme check
   * they would reduce to `javascript://` and land in a comparison they have no
   * business being in.
   */
  it.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"])(
    "returns null for the %s scheme",
    (input) => {
      expect(toOrigin(input)).toBeNull();
    },
  );
});
