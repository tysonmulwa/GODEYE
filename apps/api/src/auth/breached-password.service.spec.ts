/**
 * Breached-password screening (NIST SP 800-63B §5.1.1.2, ASVS 5.0 V6.2.5).
 *
 * Two things are being tested and only one of them is the happy path. The
 * other is that the password never leaves this process, which is a property of
 * the *request*, not of the answer — so it is asserted against what was sent,
 * not against what came back.
 */
jest.mock("../common/http-client", () => ({
  httpRequest: jest.fn(),
  TIMEOUTS: { health: 3_000 },
}));

import { createHash } from "crypto";
import { BreachedPasswordService, countFor } from "./breached-password.service";
import { httpRequest } from "../common/http-client";

const request = httpRequest as unknown as jest.Mock;

/** The API answers `SUFFIX:COUNT` per line, CRLF. */
const rangeResponse = (lines: string[]) => ({
  text: async () => lines.join("\r\n"),
});

const sha1 = (value: string) => createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();

describe("countFor", () => {
  it("finds a suffix and returns its count", () => {
    expect(countFor("ABC:5\r\nDEF:11", "ABC")).toBe(5);
    expect(countFor("ABC:5\r\nDEF:11", "DEF")).toBe(11);
  });

  it("returns 0 for a suffix that is not there", () => {
    expect(countFor("ABC:5", "ZZZ")).toBe(0);
  });

  /**
   * The `Add-Padding` header makes the service return fabricated entries with a
   * count of 0, so the response size leaks nothing. A check that treated
   * "present in the response" as "breached" would reject every password ever
   * submitted, and would look like the feature working.
   */
  it("treats a padding entry as not found", () => {
    expect(countFor("ABC:0\r\nDEF:3", "ABC")).toBe(0);
  });

  it("is case insensitive, because the API returns upper and hashes may not", () => {
    expect(countFor("abc:7", "ABC")).toBe(7);
    expect(countFor("ABC:7", "abc")).toBe(7);
  });

  it("survives a malformed line rather than throwing mid-registration", () => {
    expect(countFor("garbage\r\nABC:5", "ABC")).toBe(5);
    expect(countFor("ABC:notanumber", "ABC")).toBe(0);
    expect(countFor("", "ABC")).toBe(0);
  });
});

describe("BreachedPasswordService", () => {
  let service: BreachedPasswordService;

  beforeEach(() => {
    request.mockReset();
    service = new BreachedPasswordService();
  });

  describe("k-anonymity", () => {
    /**
     * The property that makes this acceptable to ship at all. If the full hash
     * were sent, a third party would learn a value that a rainbow table turns
     * back into the password — on every registration, for every user.
     */
    it("sends only the first five hex characters of the digest", async () => {
      request.mockResolvedValue(rangeResponse([]));
      const password = "correct horse battery staple";
      await service.assertNotBreached(password);

      const [url] = request.mock.calls[0];
      const digest = sha1(password);
      expect(url).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
      // The suffix — the part that identifies the password — must not appear.
      expect(url).not.toContain(digest.slice(5));
      expect(url).not.toContain(password);
    });

    it("never puts the password anywhere in the request", async () => {
      request.mockResolvedValue(rangeResponse([]));
      await service.assertNotBreached("hunter2hunter2");
      expect(JSON.stringify(request.mock.calls)).not.toContain("hunter2hunter2");
    });

    /** Without padding, the response's byte count narrows the bucket. */
    it("asks for padding, so the response size leaks nothing either", async () => {
      request.mockResolvedValue(rangeResponse([]));
      await service.assertNotBreached("anything at all");
      expect(request.mock.calls[0][1].headers["Add-Padding"]).toBe("true");
    });

    it("gives the request a deadline", async () => {
      request.mockResolvedValue(rangeResponse([]));
      await service.assertNotBreached("anything at all");
      expect(request.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
      // Its own breaker bucket, so an HIBP outage cannot trip the one guarding
      // a publishing platform.
      expect(request.mock.calls[0][1].upstream).toBe("hibp");
    });
  });

  describe("the decision", () => {
    it("accepts a password the corpus does not contain", async () => {
      request.mockResolvedValue(rangeResponse(["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:4"]));
      await expect(service.assertNotBreached("a password nobody has used")).resolves.toBeUndefined();
    });

    it("refuses a password the corpus does contain", async () => {
      const digest = sha1("Password12");
      request.mockResolvedValue(rangeResponse([`${digest.slice(5)}:3861`]));
      await expect(service.assertNotBreached("Password12")).rejects.toMatchObject({
        response: { code: "PASSWORD_BREACHED" },
      });
    });

    /**
     * One appearance is enough. "Only breached a little" is not a property that
     * exists — the list an attacker holds does not have a frequency threshold.
     */
    it("refuses a password seen exactly once", async () => {
      const digest = sha1("seen-once-somewhere");
      request.mockResolvedValue(rangeResponse([`${digest.slice(5)}:1`]));
      await expect(service.assertNotBreached("seen-once-somewhere")).rejects.toThrow();
    });

    /**
     * The count is a fingerprint. "Seen 3,861 times" narrows the candidate set
     * for anybody who can read the response, and it tells the person nothing
     * they can act on.
     */
    it("does not tell the caller how many times, or echo the password", async () => {
      const digest = sha1("Password12");
      request.mockResolvedValue(rangeResponse([`${digest.slice(5)}:3861`]));
      await expect(service.assertNotBreached("Password12")).rejects.toMatchObject({
        response: {
          message: expect.not.stringContaining("3861"),
        },
      });
      await expect(service.assertNotBreached("Password12")).rejects.toMatchObject({
        response: { message: expect.not.stringContaining("Password12") },
      });
    });

    /** It must not read as "your account was breached", which it is not. */
    it("says what it actually means", async () => {
      const digest = sha1("Password12");
      request.mockResolvedValue(rangeResponse([`${digest.slice(5)}:3861`]));
      await expect(service.assertNotBreached("Password12")).rejects.toMatchObject({
        response: { message: expect.stringContaining("does not mean your account was breached") },
      });
    });
  });

  describe("when the service is unreachable", () => {
    /**
     * Fails OPEN, and this is the only control in the codebase that does.
     *
     * Everything else follows the rule that a check which cannot reach its
     * dependency denies. That rule is right for an authorization decision,
     * where denying costs one request. It is wrong here: this runs on password
     * CHANGE as well as registration, so failing closed means an HIBP outage
     * stops somebody rotating a password they believe is compromised. Refusing
     * that is worse security than accepting a weak password, not better.
     */
    it("lets the password through rather than blocking every signup", async () => {
      request.mockRejectedValue(new Error("ETIMEDOUT"));
      await expect(service.assertNotBreached("Password12")).resolves.toBeUndefined();
    });

    it("survives a response body it cannot read", async () => {
      request.mockResolvedValue({
        text: async () => {
          throw new Error("socket hang up");
        },
      });
      await expect(service.assertNotBreached("Password12")).resolves.toBeUndefined();
    });

    /**
     * Loudly once, not on every request. An outage during a signup spike would
     * otherwise write a line per registration, and the signal drowns in itself.
     */
    it("logs the outage once", async () => {
      const error = jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
      request.mockRejectedValue(new Error("ETIMEDOUT"));
      await service.assertNotBreached("one");
      await service.assertNotBreached("two");
      await service.assertNotBreached("three");
      expect(error).toHaveBeenCalledTimes(1);
      // And it says what stopped applying, so the log is actionable.
      expect(error.mock.calls[0][0]).toContain("length and character policy");
    });
  });
});
