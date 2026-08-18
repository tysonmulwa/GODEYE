import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { env } from "./env";

/**
 * AES-256-GCM encryption for platform credentials at rest.
 * Format: base64(iv) . base64(authTag) . base64(ciphertext)
 */
@Injectable()
export class CryptoService {
  private key(): Buffer {
    const hex = env.tokenEncryptionKey();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
    }
    return Buffer.from(hex, "hex");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }

  /** SHA-256 hex digest, used to store refresh tokens without their plaintext. */
  sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
