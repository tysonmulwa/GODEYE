import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { requiredHexKey, assertStrongKey } from "./secrets";

/**
 * AES-256-GCM encryption for platform credentials and MFA secrets at rest.
 *
 * Two formats are readable:
 *
 *   legacy  base64(iv) "." base64(tag) "." base64(ct)          — no AAD, current key
 *   v1      "v1." keyId "." base64(iv) "." base64(tag) "." base64(ct)
 *
 * v1 is what is written now. It carries a key id so a key can be rotated
 * without a flag day (NIST SP 800-57 §8), and it binds an AAD label — the
 * owning org or user — so a ciphertext lifted out of one tenant's row cannot be
 * pasted into another's and decrypt (NIST SP 800-38D §5.1.1). The legacy branch
 * exists only to read rows written before this change; nothing produces it.
 */
@Injectable()
export class CryptoService {
  /** First 8 hex of SHA-256(key bytes). Identifies a key without revealing it. */
  private keyId(key: Buffer): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 8);
  }

  private currentKey(): Buffer {
    return requiredHexKey("TOKEN_ENCRYPTION_KEY");
  }

  /**
   * The key being retired, if a rotation is in flight. Optional: absent means
   * no rotation, which is the normal state. A weak previous key is still
   * refused — accepting one would let a rotation "away from" a bad key leave
   * the bad key in service indefinitely.
   */
  private previousKeys(): Buffer[] {
    const raw = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map((hex) => {
        if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
          throw new Error("TOKEN_ENCRYPTION_KEY_PREVIOUS entries must be 64 hex characters");
        }
        assertStrongKey("TOKEN_ENCRYPTION_KEY_PREVIOUS", hex);
        return Buffer.from(hex, "hex");
      });
  }

  /**
   * Encrypt, binding the ciphertext to its owner.
   *
   * `aad` should name the row's tenant — `org:<id>` or `user:<id>`. It is not
   * secret and is not stored: the caller already knows it, because it is the
   * foreign key it read the row by. That is the point — decryption fails unless
   * the ciphertext is being read from the row it was written to.
   */
  encrypt(plaintext: string, aad?: string): string {
    const key = this.currentKey();
    const iv = randomBytes(12); // 96-bit, CSPRNG, fresh per encryption
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      "v1",
      this.keyId(key),
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  decrypt(payload: string, aad?: string): string {
    const parts = payload.split(".");

    if (parts[0] === "v1") {
      const [, keyId, ivB64, tagB64, dataB64] = parts;
      if (!keyId || !ivB64 || !tagB64 || !dataB64) {
        throw new Error("Malformed encrypted payload");
      }
      const key = this.keyFor(keyId);
      return this.open(key, ivB64, tagB64, dataB64, aad);
    }

    // Legacy: three parts, current key, no AAD.
    const [ivB64, tagB64, dataB64] = parts;
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
    for (const key of [this.currentKey(), ...this.previousKeys()]) {
      try {
        return this.open(key, ivB64, tagB64, dataB64, undefined);
      } catch {
        // Try the next key; a rotation in flight is the expected reason.
      }
    }
    throw new Error("Unable to decrypt payload with any configured key");
  }

  /** Resolve a key id to its key, so rotation does not require re-encrypting first. */
  private keyFor(keyId: string): Buffer {
    for (const key of [this.currentKey(), ...this.previousKeys()]) {
      const candidate = Buffer.from(this.keyId(key));
      const wanted = Buffer.from(keyId);
      if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) return key;
    }
    throw new Error(
      `Ciphertext was written with key ${keyId}, which is neither TOKEN_ENCRYPTION_KEY nor ` +
        `listed in TOKEN_ENCRYPTION_KEY_PREVIOUS. See docs/security/KEY-MANAGEMENT.md.`,
    );
  }

  private open(
    key: Buffer,
    ivB64: string,
    tagB64: string,
    dataB64: string,
    aad: string | undefined,
  ): string {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  encryptJson(value: unknown, aad?: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(payload: string, aad?: string): T {
    return JSON.parse(this.decrypt(payload, aad)) as T;
  }

  /** SHA-256 hex digest, used to store refresh tokens without their plaintext. */
  sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
