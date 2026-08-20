import { BadRequestException } from "@nestjs/common";
import { isIP } from "net";
import { lookup } from "dns/promises";
import { egressBlocked } from "./metrics";

/** A small, fixed set of reasons, so the metric stays bounded. */
function bucket(reason: string): string {
  for (const label of ["private", "internal service", "http or https", "port", "credentials", "resolve"]) {
    if (reason.includes(label)) return label.replace(/ /g, "_");
  }
  return "other";
}

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

/**
 * An IPv6 address as its eight 16-bit groups, or null if it will not parse.
 *
 * Written out rather than pattern-matched on the text because the text is not
 * stable. `new URL()` normalises an address before anything here ever sees it,
 * and it does so in the form that defeats a regex:
 *
 *     new URL("http://[::ffff:10.0.0.1]/").hostname  ===  "[::ffff:a00:1]"
 *
 * The previous version matched `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`, which the
 * normalised hex form never satisfies — so `::ffff:169.254.169.254` reached the
 * generic checks, matched no blocked prefix, and was allowed straight through
 * to the cloud metadata endpoint. Found by url-guard.spec.ts, not by review.
 */
function parseV6(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (text.includes("%")) text = text.slice(0, text.indexOf("%")); // zone id

  // A trailing dotted quad (::ffff:10.0.0.1) is two more groups.
  const tail: number[] = [];
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const value = v4ToInt(dotted[1]);
    if (value === null) return null;
    tail.push(value >>> 16, value & 0xffff);
    // Drop the quad and the single ':' that joined it, but leave a '::' intact.
    text = text.slice(0, -dotted[1].length);
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part
      .split(":")
      .filter(Boolean)
      .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));

  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - rest.length - tail.length).fill(0), ...rest, ...tail]
      : [...head, ...rest, ...tail];

  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function isBlockedV6(address: string): boolean {
  const g = parseV6(address);
  if (g === null) return true; // unparseable is not "fine"

  const zeros = (count: number) => g.slice(0, count).every((group) => group === 0);
  const asV4 = () => [g[6] >>> 8, g[6] & 0xff, g[7] >>> 8, g[7] & 0xff].join(".");

  // ::ffff:0:0/96 — IPv4-mapped. Judge it as the v4 address it will connect to.
  if (zeros(5) && g[5] === 0xffff) return isBlockedV4(asV4());
  // ::/96 — the deprecated IPv4-compatible form, and ::1 and :: themselves.
  if (zeros(7)) return true;
  if (zeros(6)) return isBlockedV4(asV4());
  // 64:ff9b::/96 — NAT64. A translator on the path turns this into a v4
  // connection to the embedded address, so the embedded address is what counts.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4(asV4());
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
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
    // Bucketed, never the raw reason: it contains the host and the address, and
    // a metric label carrying customer input is unbounded cardinality — the
    // same mistake as putting an id in a route label.
    egressBlocked.add(1, { reason: bucket(reason) });
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
