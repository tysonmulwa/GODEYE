import { backoffDelaySeconds } from "./login-backoff.service";

/**
 * The shape of the curve, which is the part worth pinning.
 *
 * The route throttle caps attempts per caller. That is the wrong axis on its
 * own: credential stuffing spreads one guess per address across thousands of
 * addresses and never trips a per-caller limit. This counts against the account
 * as well.
 */
describe("backoffDelaySeconds", () => {
  it("does not punish someone who forgot their password", () => {
    for (let n = 0; n <= 5; n++) expect(backoffDelaySeconds(n)).toBe(0);
  });

  it("grows exponentially once the free attempts are spent", () => {
    expect(backoffDelaySeconds(6)).toBe(15);
    expect(backoffDelaySeconds(7)).toBe(30);
    expect(backoffDelaySeconds(8)).toBe(60);
    expect(backoffDelaySeconds(9)).toBe(120);
  });

  it("caps, because an unbounded lockout is a denial-of-service", () => {
    // Anybody can trigger this against a real person just by guessing at their
    // address, so it must always end.
    expect(backoffDelaySeconds(50)).toBe(15 * 60);
    expect(backoffDelaySeconds(1_000)).toBe(15 * 60);
  });

  it("is monotonic, so more failures never means a shorter wait", () => {
    let previous = -1;
    for (let n = 0; n < 40; n++) {
      const delay = backoffDelaySeconds(n);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });
});
