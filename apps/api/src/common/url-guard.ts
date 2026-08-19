import { BadRequestException } from "@nestjs/common";
import { isIP } from "net";
import { lookup } from "dns/promises";

/**
 * The API's half of the SSRF fix (S-2, S-3).
 *
 * The authoritative guard is `engine/security/egress.py`, because it is the
 * process that actually opens the socket and it can pin the resolved address at
 * connect time. This one refuses the request at the boundary, before anything
 * is enqueued — which matters for three reasons:
 *
 *   1. A 200 that queues a task has already lost. The caller learns the URL was
 *      accepted, and whatever the worker does next happens out of sight.
 *   2. `SeoAudit` rows are created before the enqueue, so an unvalidated URL
 *      leaves a record and a job even when the worker later refuses it.
 *   3. The customer gets a clear error immediately, rather than a task that
 *      fails silently minutes later.
 *
 * The two lists are deliberately duplicated rather than shared over the wire:
 * one of them being unreachable must not turn the other off. They are kept in
 * step by `docs/security/SSRF.md` and by the exploit suite, which runs the same
 * target list against both.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443]);

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [
  ".internal",
  ".railway.internal",
  ".local",
  ".localhost",
  ".cluster.local",
  ".svc",
  ".svc.cluster.local",
];

/** [network, prefix bits] pairs, as 32-bit integers for v4. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, and the cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Alibaba Cloud's metadata service, which looks like an ordinary address. */
const BLOCKED_V4_EXACT = new Set(["100.100.100.200", "255.255.255.255"]);

function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isBlockedV4(address: string): boolean {
  if (BLOCKED_V4_EXACT.has(address)) return true;
  const value = v4ToInt(address);
  if (value === null) return true; // unparseable is not "fine"
  return BLOCKED_V4.some(([network, bits]) => {
    const base = v4ToInt(network);
    if (base === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  // An IPv4-mapped literal (::ffff:127.0.0.1) is the bypass that gets missed:
  // it matches no IPv6 range and connects to loopback.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (lower === "::1" || lower === "::") return true;
  const head = lower.split(":")[0];
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (/^ff/.test(head)) return true; // ff00::/8 multicast
  return false;
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true;
}

export class BlockedUrlError extends BadRequestException {
  constructor(url: string, reason: string) {
    super({
      code: "URL_NOT_ALLOWED",
      message: `That URL cannot be fetched: ${reason}`,
      url,
    });
  }
}

/**
 * Refuse a customer-supplied URL that points anywhere but the public internet.
 *
 * Resolves the hostname and rejects if **any** answer is private: a record with
 * one public and one private address would otherwise be a coin flip.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(raw, "it is not a valid URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(raw, `${url.protocol.replace(":", "")} is not http or https`);
  }
  if (url.username || url.password) {
    throw new BlockedUrlError(raw, "credentials in a URL are not allowed");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new BlockedUrlError(raw, `port ${port} is not 80 or 443`);
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedUrlError(raw, "it has no host");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(raw, `${host} names an internal service`);
  }

  // A literal address never reaches DNS, so judge it as written.
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (blockedAddress(literal)) {
      throw new BlockedUrlError(raw, `${literal} is a private, loopback or reserved address`);
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(raw, `${host} does not resolve`);
  }
  if (!addresses.length) throw new BlockedUrlError(raw, `${host} resolves to nothing`);
  for (const { address } of addresses) {
    if (blockedAddress(address)) {
      throw new BlockedUrlError(raw, `${host} resolves to ${address}, which is not public`);
    }
  }
  return url;
}
