#!/usr/bin/env node
/**
 * Repo-native lint rules, one per remediation finding.
 *
 * These are rules whose *reason* is a specific defect this codebase had. They
 * live here rather than in an ESLint plugin for two reasons: they span TypeScript
 * and Python, and they must be runnable with no install step, so a CI job cannot
 * quietly skip them because a dependency failed to resolve.
 *
 *     node scripts/lint-rules.mjs
 *
 * Exit code 1 with a file:line for every violation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  ".turbo",
  ".open-next",
  "coverage",
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT).filter((f) => /\.(ts|tsx|py)$/.test(f));
const violations = [];

function check(file, { test, message, appliesTo, exempt = [] }) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (!appliesTo(rel)) return;
  if (exempt.some((e) => rel.endsWith(e))) return;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // An explicit, reviewable escape. Accepted on the line itself or in the
    // three lines above it, because the reason usually needs a sentence or two
    // and neither fits on the line being excused.
    const nearby = [line, lines[i - 1], lines[i - 2], lines[i - 3]];
    if (nearby.some((l) => l?.includes("lint-rules:allow"))) return;

    // A rule that fires on the comment EXPLAINING the rule is a rule nobody
    // will keep. Comments describe; they do not execute.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) return;

    if (test(line, rel)) violations.push(`${rel}:${i + 1}  ${message}\n    ${trimmed}`);
  });
}

const RULES = [
  {
    // B-4. Node's fetch has no total-request timeout, so a hung dependency held
    // a request, an event-loop slot and a database connection for five minutes.
    id: "no-bare-fetch",
    message: "call httpRequest() from common/http-client.ts — a bare fetch has no deadline [B-4]",
    appliesTo: (rel) => rel.startsWith("apps/api/src/") && rel.endsWith(".ts"),
    exempt: ["common/http-client.ts"],
    test: (line) => /(?<![.\w])fetch\(/.test(line) && !line.trim().startsWith("*"),
  },
  {
    // S-2/S-3/S-20. Four separate SSRF sinks, each of which looked fine on its
    // own review. The guard is only worth anything if it is the single door.
    id: "no-direct-http-python",
    message: "fetch user-supplied URLs through security/egress.py safe_fetch [S-2/S-3/S-20]",
    appliesTo: (rel) => rel.startsWith("apps/engine/src/") && rel.endsWith(".py"),
    exempt: [
      "security/egress.py",
      // Fixed platform hosts written into the source; no part is user-supplied.
      "publishers/meta.py",
      "publishers/x.py",
      "publishers/discord.py",
      "publishers/reddit.py",
      "publishers/tiktok.py", // TikTok's own upload URLs, returned by TikTok
      "seo/indexnow.py", // api.indexnow.org, a constant
      "ai/provider.py", // Anthropic / OpenAI / Google endpoints, all constants
      "products/render.py", // BROWSER_RENDER_URL, set by the operator, not a customer
      "tasks/token_refresh.py", // the three platform token endpoints, all constants
    ],
    test: (line) => /httpx\.(Client|get|post)\(|requests\.(get|post)\(/.test(line),
  },
  {
    // S-8. `.catch(() => undefined)` on the payment idempotency marker meant a
    // transient DB error silently removed the correctness mechanism, and
    // Paystack's retry then credited the customer a second time.
    id: "no-silent-catch-ts",
    message: "log it or rethrow it — a swallowed error is how S-8 stayed invisible",
    appliesTo: (rel) => /^apps\/(api|web)\/src\//.test(rel) && /\.tsx?$/.test(rel),
    test: (line) =>
      /\.catch\(\s*\(\s*\)\s*=>\s*(undefined|null|\{\s*\})\s*\)/.test(line) ||
      /catch\s*\([^)]*\)\s*\{\s*\}/.test(line),
  },
  {
    id: "no-bare-except-python",
    message: "name the exception and log it — a bare except hides the failure it catches",
    appliesTo: (rel) => rel.startsWith("apps/engine/") && rel.endsWith(".py"),
    test: (line) => /^\s*except\s*:/.test(line),
  },
  {
    // C-1. Two independent defences, and this keeps the second one honest: the
    // session key must never appear anywhere near OAuth state again.
    id: "oauth-state-not-session-key",
    message: "OAuth state must use env.oauthStateSecret(), never the session key [C-1]",
    appliesTo: (rel) => rel.startsWith("apps/api/src/connections/"),
    test: (line) => /jwtAccessSecret/.test(line),
  },
  {
    // D-4. `abReport` loaded an org's ENTIRE analytics history into memory and
    // discarded nearly all of it in a JS loop — ~43,000 rows for a workspace
    // with ten channels running six months, to pick two numbers. A findMany
    // with no `take` is a query whose cost is set by the customer's age.
    //
    // Multi-line calls are checked by the block rule below; this catches the
    // single-line form, which is how they usually start.
    id: "no-unbounded-findMany",
    message: "give findMany a `take` — a query with no bound is one the data grows [D-4]",
    appliesTo: (rel) => rel.startsWith("apps/api/src/") && rel.endsWith(".ts"),
    test: (line) =>
      /\.findMany\(\{.*\}\)/.test(line) && !/\btake\s*:/.test(line) && !/where:\s*\{\s*id:/.test(line),
  },
  {
    // S-1. The guard is global now; a per-controller @UseGuards(RolesGuard) is a
    // sign somebody is re-introducing the pattern that let VIEWER write.
    id: "no-per-controller-roles-guard",
    message: "RolesGuard is global (APP_GUARD); per-controller wiring is what caused S-1",
    appliesTo: (rel) => rel.startsWith("apps/api/src/") && rel.endsWith(".ts"),
    exempt: ["common/roles.guard.ts", "app.module.ts"],
    test: (line) => /@UseGuards\([^)]*RolesGuard/.test(line),
  },
];

for (const file of files) for (const rule of RULES) check(file, rule);

/**
 * D-4, the multi-line form.
 *
 * The line rule above only sees `findMany({ … })` written on one line, and
 * almost none of them are — `abReport`'s was four lines and read an entire
 * workspace's analytics history. This walks the braces so the shape of the
 * formatting cannot decide whether a rule applies.
 */
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (!rel.startsWith("apps/api/src/") || !rel.endsWith(".ts") || rel.endsWith(".spec.ts")) continue;
  const src = readFileSync(file, "utf8");

  for (const match of src.matchAll(/\.findMany\(\{/g)) {
    const open = src.indexOf("{", match.index);
    let depth = 0;
    let end = open;
    while (end < src.length) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
      end++;
    }
    const block = src.slice(open, end + 1);
    if (/\btake\s*:/.test(block)) continue;

    const line = src.slice(0, match.index).split("\n").length;
    // The escape hatch is read from the three lines above the call, same as
    // everywhere else.
    const preceding = src.split("\n").slice(Math.max(0, line - 4), line).join("\n");
    if (preceding.includes("lint-rules:allow")) continue;

    violations.push(
      `${rel}:${line}  give findMany a \`take\` — a query with no bound is one the data grows [D-4]` +
        `\n    ${block.replace(/\s+/g, " ").slice(0, 100)}`,
    );
  }
}

if (violations.length) {
  process.stderr.write(
    `\n${violations.length} lint-rule violation(s):\n\n${violations.join("\n")}\n\n` +
      `Each rule exists because of a specific finding. If one is genuinely wrong here,\n` +
      `add a \`lint-rules:allow\` comment on the line and say why in the commit.\n`,
  );
  process.exit(1);
}

process.stdout.write(`lint-rules: ${RULES.length} rules, ${files.length} files, clean\n`);
