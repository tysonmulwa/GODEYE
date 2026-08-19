import { CryptoService } from "./crypto.service";

// Real 32-byte keys. The fixture used to be "a".repeat(64) — every byte 0xaa —
// which the weak-key check added for finding S-6 now rejects. That rejection is
// the fix, so the fixture moved rather than the rule.
const KEY = "b3126e1542fa317004bc1c192e87c6afc2bbfae1674ffae2b159df41d7743209";
const OTHER_KEY = "6eda579dfc262ed8032593429aab8b84bbe279c297e8e95f0707617c7c35c49d";

describe("CryptoService", () => {
  let crypto: CryptoService;

  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    crypto = new CryptoService();
  });

  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  });

  it("round-trips plaintext", () => {
    const secret = "super-secret-platform-token-123";
    const encrypted = crypto.encrypt(secret);
    expect(encrypted).not.toContain(secret);
    expect(crypto.decrypt(encrypted)).toBe(secret);
  });

  it("produces a different ciphertext per call (random IV)", () => {
    expect(crypto.encrypt("same")).not.toBe(crypto.encrypt("same"));
  });

  it("round-trips JSON credentials", () => {
    const creds = { botToken: "123:abc", chatId: "-100555" };
    expect(crypto.decryptJson(crypto.encryptJson(creds))).toEqual(creds);
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const encrypted = crypto.encrypt("payload");
    const [v, keyId, iv, tag, data] = encrypted.split(".");
    const tampered = Buffer.from(data, "base64");
    tampered[0] ^= 0xff;
    expect(() =>
      crypto.decrypt([v, keyId, iv, tag, tampered.toString("base64")].join(".")),
    ).toThrow();
  });

  it("rejects a malformed key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "too-short";
    expect(() => new CryptoService().encrypt("x")).toThrow(/64 hex/);
  });

  it("hashes stably with sha256", () => {
    expect(crypto.sha256("token")).toBe(crypto.sha256("token"));
    expect(crypto.sha256("token")).toHaveLength(64);
  });

  // ---------- S-6: a format-valid key that is not a key ----------

  it.each([
    ["all zeros — what .env.example used to ship", "0".repeat(64)],
    ["one byte repeated", "a".repeat(64)],
    ["two byte values", "ab".repeat(32)],
    [
      "a counting sequence",
      Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(""),
    ],
  ])("refuses %s", (_label, hex) => {
    process.env.TOKEN_ENCRYPTION_KEY = hex;
    expect(() => new CryptoService().encrypt("a platform access token")).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  it("refuses a missing key", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => new CryptoService().encrypt("x")).toThrow(/not set/);
  });

  // ---------- Tenant binding (AAD) ----------

  it("binds a ciphertext to the workspace it was written for", () => {
    const blob = crypto.encryptJson({ botToken: "123:abc" }, "org:org_a");
    expect(crypto.decryptJson(blob, "org:org_a")).toEqual({ botToken: "123:abc" });
    // The whole point: the same row pasted into another tenant must not open.
    expect(() => crypto.decrypt(blob, "org:org_b")).toThrow();
    expect(() => crypto.decrypt(blob)).toThrow();
  });

  // ---------- Key versioning (NIST SP 800-57 rotation) ----------

  it("records which key wrote a ciphertext", () => {
    const parts = crypto.encrypt("x").split(".");
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
    expect(parts).toHaveLength(5);
  });

  it("still reads a ciphertext written by the previous key mid-rotation", () => {
    process.env.TOKEN_ENCRYPTION_KEY = OTHER_KEY;
    const old = new CryptoService().encrypt("stored last month", "org:org_a");

    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OTHER_KEY;
    expect(new CryptoService().decrypt(old, "org:org_a")).toBe("stored last month");
  });

  it("names the key it cannot find rather than failing blankly", () => {
    process.env.TOKEN_ENCRYPTION_KEY = OTHER_KEY;
    const old = new CryptoService().encrypt("x", "org:org_a");

    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    expect(() => new CryptoService().decrypt(old, "org:org_a")).toThrow(
      /TOKEN_ENCRYPTION_KEY_PREVIOUS/,
    );
  });

  it("still reads rows written before versioning existed", () => {
    // Legacy three-part format, current key, no AAD. Nothing writes this any
    // more; every credential stored before this change is in it.
    const { createCipheriv, randomBytes } = require("crypto") as typeof import("crypto");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
    const ct = Buffer.concat([cipher.update("legacy secret", "utf8"), cipher.final()]);
    const legacy = [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ct.toString("base64"),
    ].join(".");

    expect(crypto.decrypt(legacy)).toBe("legacy secret");
  });
});
