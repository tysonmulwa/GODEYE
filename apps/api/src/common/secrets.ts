/**
 * Validation for values that are only ever secrets.
 *
 * The audit's S-5 and S-6 were both the same shape: a variable with a fallback
 * that produces a *working* system. Nothing breaks, nothing warns, and the
 * system is authenticated by a string published on GitHub. So the rule here is
 * that a secret has no fallback — reading one that is missing, published, or
 * entropy-free throws, and it throws at boot rather than at the first request
 * that needed it.
 *
 * Dev convenience is not lost, it is made explicit: set
 * ALLOW_INSECURE_DEV_DEFAULTS=true with NODE_ENV=development and the documented
 * dev values apply. Anywhere else they are refused.
 */

/**
 * Values that have appeared in this repository, in .env.example, or in its
 * documentation. Any of them reaching a running process means a deployment
 * forgot a variable, so they are refused by name rather than by entropy — a
 * published string can be perfectly random and still be public.
 */
export const PUBLISHED_DEFAULTS = new Set([
  "dev-engine-secret",
  "godeye-verify",
  "godeye_dev_password",
  "godeye_dev_secret",
  "change-me",
  "changeme",
  "REPLACE_ME",
  "secret",
  "password",
]);

export function allowInsecureDevDefaults(): boolean {
  return (
    (process.env.NODE_ENV ?? "development") === "development" &&
    process.env.ALLOW_INSECURE_DEV_DEFAULTS === "true"
  );
}

/**
 * Shannon entropy per character, in bits. A rough but effective filter: a
 * 64-character string of one repeated byte scores 0, "REPLACE_ME_REPLACE_ME"
 * scores low, and `openssl rand -hex 32` scores near 4.
 */
export function shannonBits(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export class InsecureConfigError extends Error {
  constructor(name: string, reason: string) {
    super(
      `${name} is ${reason}. Generate one with: openssl rand -hex 32 — ` +
        `and never reuse a value that has appeared in a repository or a docs page.`,
    );
    this.name = "InsecureConfigError";
  }
}

/**
 * A required secret. `devDefault` applies only under
 * NODE_ENV=development + ALLOW_INSECURE_DEV_DEFAULTS=true; it is never a
 * silent `??` fallback.
 */
export function requiredSecret(
  name: string,
  opts: { minLength?: number; devDefault?: string } = {},
): string {
  const minLength = opts.minLength ?? 32;
  const raw = process.env[name]?.trim();

  if (!raw) {
    if (opts.devDefault && allowInsecureDevDefaults()) return opts.devDefault;
    throw new InsecureConfigError(name, "not set");
  }
  if (PUBLISHED_DEFAULTS.has(raw)) {
    // Deliberately allowed to *keep* working in an explicitly-flagged dev box,
    // because the alternative is developers exporting real secrets locally.
    if (allowInsecureDevDefaults()) return raw;
    throw new InsecureConfigError(name, "set to a value published in this repository");
  }
  if (raw.length < minLength) {
    throw new InsecureConfigError(name, `shorter than ${minLength} characters`);
  }
  if (shannonBits(raw) < 2.5 && !allowInsecureDevDefaults()) {
    throw new InsecureConfigError(name, "not random enough to be a secret");
  }
  return raw;
}

/**
 * A 32-byte key in hex, rejected when it is format-valid but not a key.
 *
 * `.env.example` used to ship 64 zeros, which passed the only check that
 * existed (`/^[0-9a-fA-F]{64}$/`). Every platform credential and every TOTP
 * secret in a workspace started from that file was encrypted with a key that
 * is in the repository.
 */
export function requiredHexKey(name: string, byteLength = 32): Buffer {
  const raw = process.env[name]?.trim();
  if (!raw) throw new InsecureConfigError(name, "not set");
  if (!new RegExp(`^[0-9a-fA-F]{${byteLength * 2}}$`).test(raw)) {
    throw new InsecureConfigError(name, `not ${byteLength * 2} hex characters (${byteLength} bytes)`);
  }
  assertStrongKey(name, raw);
  return Buffer.from(raw, "hex");
}

/** The entropy half of requiredHexKey, separated so callers holding a hex
 *  string (the engine's mirror, a rotation job) can reuse it. */
export function assertStrongKey(name: string, hex: string): void {
  const bytes = Buffer.from(hex, "hex");
  const distinct = new Set(bytes).size;
  if (distinct === 1) throw new InsecureConfigError(name, "a single byte repeated");
  if (distinct < 16) {
    throw new InsecureConfigError(name, `only ${distinct} distinct byte values — not a random key`);
  }
  // Counting sequences catches 000102..1f and deadbeefdeadbeef… , which have
  // enough distinct bytes to clear the check above.
  let ascending = 0;
  for (let i = 1; i < bytes.length; i++) if (bytes[i] === bytes[i - 1] + 1) ascending++;
  if (ascending > bytes.length / 2) throw new InsecureConfigError(name, "a counting sequence");
}
