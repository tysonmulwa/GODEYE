import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { httpRequest, TIMEOUTS } from "../common/http-client";
import { breachedPasswordChecks } from "../common/metrics";

/**
 * Refuse passwords that are already in a public breach corpus.
 *
 * NIST SP 800-63B §5.1.1.2 makes this a **requirement**, not an enhancement,
 * and it is the one password rule with real evidence behind it. Composition
 * rules — an uppercase letter, a digit, a symbol — were removed from 800-63B in
 * 2017 because they push people toward `Password1!`, which is in every list
 * ever published. The existing policy here is exactly that shape: ten
 * characters, one lowercase, one uppercase-or-digit. `Password12` passes it and
 * appears in breach corpora tens of thousands of times.
 *
 * ASVS 5.0 V6.2.5. OWASP Top 10 A07:2021 (Identification and Authentication
 * Failures) names credential stuffing as the mechanism, and credential stuffing
 * only works because the password was already known.
 *
 * ## The password never leaves this process
 *
 * k-anonymity, which is Have I Been Pwned's range API. SHA-1 the password, send
 * the **first five hex characters** of the digest, and get back every suffix
 * that shares that prefix — around 800 of them. The match happens locally.
 *
 * The service learns five hex characters, which is one of 1,048,576 buckets
 * covering the entire corpus. It cannot tell which password was checked, which
 * account it belongs to, or whether the answer was yes.
 *
 * SHA-1 is not a security choice here and is not a weakness: it is the index
 * the corpus is published under. Nothing is stored under it and nothing is
 * authenticated by it.
 */

/** Where the range API lives. A constant, so the SSRF guard has no work to do. */
const RANGE_API = "https://api.pwnedpasswords.com/range";

/**
 * How many appearances make a password unusable.
 *
 * One. A password that appears even once in a public corpus is a password an
 * attacker's list already contains, and "only breached a little" is not a
 * property that exists. The threshold is a constant rather than a setting
 * because a tunable here is a dial somebody turns up during an incident.
 */
const MAX_APPEARANCES = 0;

@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);
  private warned = false;

  /**
   * Throws if the password appears in a public breach.
   *
   * **Fails open, deliberately, and this is the one place in this codebase that
   * says so out loud.** Everything else in the remediation fails closed, on the
   * rule that a check which cannot reach its dependency denies.
   *
   * That rule is right when the check is an authorization decision — denying a
   * request costs one request. It is wrong here. This check runs on
   * registration and on password change, and failing closed means: HIBP has an
   * outage, and nobody in the world can create a GODEYE account or rotate a
   * password they believe is compromised. The second half is the part that
   * decides it — refusing to let somebody change a password during an incident
   * is worse security than accepting a weak one, not better.
   *
   * The rest of the policy still applies underneath, so the outcome of an
   * outage is the policy that existed before this file, not no policy at all.
   */
  async assertNotBreached(password: string): Promise<void> {
    const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    let body: string;
    try {
      const response = await httpRequest(`${RANGE_API}/${prefix}`, {
        timeoutMs: TIMEOUTS.health,
        // Its own circuit-breaker bucket. An HIBP outage must not count toward
        // -- or be masked by -- the breaker on a platform we publish to.
        upstream: "hibp",
        headers: {
          // Pads the response with fabricated hashes so its SIZE leaks nothing
          // either. Without it, a network observer can narrow the bucket by how
          // many bytes came back.
          "Add-Padding": "true",
          "User-Agent": "godeye-password-check",
        },
      });
      body = await response.text();
    } catch (error) {
      breachedPasswordChecks.add(1, { result: "unavailable" });
      if (!this.warned) {
        this.warned = true;
        this.logger.error(
          `Breached-password screening is unavailable (${
            error instanceof Error ? error.message : String(error)
          }). Passwords are being accepted on the length and character policy ` +
            `alone. This is deliberate: see BreachedPasswordService.`,
        );
      }
      return;
    }

    const count = countFor(body, suffix);
    if (count > MAX_APPEARANCES) {
      breachedPasswordChecks.add(1, { result: "breached" });
      // Never says how many times, and never echoes the password. The count is
      // a fingerprint: "seen 3,861 times" narrows the candidate set for anyone
      // who can see the response.
      throw new BadRequestException({
        code: "PASSWORD_BREACHED",
        message:
          "That password has appeared in a public data breach and cannot be used. " +
          "It does not mean your account was breached — it means this password is " +
          "on lists attackers already have. Please choose a different one.",
      });
    }

    breachedPasswordChecks.add(1, { result: "ok" });
  }
}

/**
 * How many times `suffix` appears in a range response.
 *
 * Exported so the parsing can be tested without a network. The response is
 * `SUFFIX:COUNT` per line with CRLF endings, and the padding entries the
 * `Add-Padding` header adds arrive with a count of 0 — which must read as "not
 * found" rather than as a match, or every password fails.
 */
export function countFor(body: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).toUpperCase() !== wanted) continue;
    const count = Number.parseInt(line.slice(separator + 1), 10);
    return Number.isFinite(count) ? count : 0;
  }
  return 0;
}
