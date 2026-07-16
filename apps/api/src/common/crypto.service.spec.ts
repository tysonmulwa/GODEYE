import { CryptoService } from "./crypto.service";

describe("CryptoService", () => {
  let crypto: CryptoService;

  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    crypto = new CryptoService();
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
    const [iv, tag, data] = encrypted.split(".");
    const tampered = Buffer.from(data, "base64");
    tampered[0] ^= 0xff;
    expect(() => crypto.decrypt([iv, tag, tampered.toString("base64")].join("."))).toThrow();
  });

  it("rejects a malformed key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "too-short";
    expect(() => new CryptoService().encrypt("x")).toThrow(/64 hex/);
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
  });

  it("hashes stably with sha256", () => {
    expect(crypto.sha256("token")).toBe(crypto.sha256("token"));
    expect(crypto.sha256("token")).toHaveLength(64);
  });
});
