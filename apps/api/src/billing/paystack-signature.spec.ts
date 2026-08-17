/**
 * Paystack webhook signature verification.
 *
 * This is the only thing standing between a stranger and a free SCALE plan.
 * A forged `charge.success` naming an orgId would activate a paid subscription
 * for a payment that never happened, so the check has to reject anything it
 * cannot prove.
 *
 * Paystack signs with HMAC SHA512 over the raw request body, keyed by the
 * SECRET key rather than a separate webhook secret.
 */
import { createHmac } from "crypto";
import { env } from "../common/env";

const SECRET = "sk_test_signature_fixture";

function sign(body: string, key = SECRET): string {
  return createHmac("sha512", key).update(Buffer.from(body)).digest("hex");
}

describe("verifyPaystackSignature", () => {
  let verify: (raw: Buffer | undefined, header: string | undefined) => boolean;
  const original = env.paystack.secretKey;

  beforeAll(async () => {
    env.paystack.secretKey = SECRET;
    const { BillingService } = await import("./billing.module");
    const service = new BillingService({} as never, {} as never);
    verify = service.verifyPaystackSignature.bind(service);
  });

  afterAll(() => {
    env.paystack.secretKey = original;
  });

  const body = JSON.stringify({
    event: "charge.success",
    data: { metadata: { orgId: "org1", planCode: "SCALE" } },
  });

  it("accepts a genuine signature", () => {
    expect(verify(Buffer.from(body), sign(body))).toBe(true);
  });

  it("rejects a signature made with a different key", () => {
    expect(verify(Buffer.from(body), sign(body, "sk_live_someone_elses"))).toBe(false);
  });

  it("rejects a tampered body", () => {
    const forged = body.replace("org1", "org2");
    expect(verify(Buffer.from(forged), sign(body))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verify(Buffer.from(body), undefined)).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(verify(undefined, sign(body))).toBe(false);
  });

  it("returns false rather than throwing on a short signature", () => {
    // timingSafeEqual throws when the lengths differ, and a thrown error here
    // would surface as a 500 instead of a rejected forgery.
    expect(() => verify(Buffer.from(body), "abc")).not.toThrow();
    expect(verify(Buffer.from(body), "abc")).toBe(false);
  });

  it("refuses everything when no secret key is set", () => {
    env.paystack.secretKey = "";
    expect(verify(Buffer.from(body), sign(body))).toBe(false);
    env.paystack.secretKey = SECRET;
  });

  it("verifies the exact bytes, not re-serialised JSON", () => {
    // Key order changes the digest, so parsing and re-stringifying would fail
    // every genuine event.
    const reordered = JSON.stringify(JSON.parse(body), ["data", "event"]);
    expect(reordered).not.toEqual(body);
    expect(verify(Buffer.from(reordered), sign(body))).toBe(false);
  });
});
