#!/usr/bin/env node
/**
 * Take a backup, restore it somewhere else, and prove the copy is the same.
 *
 * The scorecard's lowest row is Backups & DR, at 3/10, for one reason: no
 * restore had ever been performed. Supabase takes the backups and nobody had
 * ever asked one to give the data back. A backup nobody has restored is a
 * hypothesis, and the moment it stops being a hypothesis is the worst possible
 * moment to find out.
 *
 * This runs the whole path — dump, create, restore, compare — and fails if the
 * restored copy differs from the source by a single table or a single row. It
 * also prints how long the restore took, which is the only honest source for an
 * RTO number: everything else is arithmetic.
 *
 * Usage:
 *   node scripts/restore-drill.mjs --source "$DATABASE_URL"
 *   node scripts/restore-drill.mjs --self-test     # logic only, no database
 *
 * Requires `pg_dump`, `pg_restore`, `psql` and `createdb` on PATH.
 *
 * ## What it will not do
 *
 * It never writes to the source. It creates a scratch database, restores into
 * that, and drops it — and it refuses to drop anything whose name does not
 * start with `restore_drill_`, because a drill that can drop the wrong database
 * is a bigger risk than the one it is testing for.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Nothing outside this shape is ever a drop target. */
const SCRATCH_PREFIX = "restore_drill_";

/**
 * The one guard that matters.
 *
 * `dropdb` is not reversible and this script runs unattended in CI. A name that
 * is empty, or that arrived from an environment variable that was not set, must
 * not resolve to something droppable.
 */
export function assertSafeScratchName(name) {
  if (typeof name !== "string" || !name.startsWith(SCRATCH_PREFIX)) {
    throw new Error(
      `refusing to drop ${JSON.stringify(name)}: a drill may only drop a database ` +
        `whose name starts with "${SCRATCH_PREFIX}"`,
    );
  }
  if (!/^[a-z0-9_]+$/.test(name) || name.length <= SCRATCH_PREFIX.length) {
    throw new Error(`refusing to drop ${JSON.stringify(name)}: not a plain identifier`);
  }
  return name;
}

/**
 * Parse `table|columns|rows` lines into a map.
 *
 * Tolerant of ordering and blank lines, strict about everything else: a line it
 * cannot read is an error rather than a skip, because a silently-dropped line
 * is a table that goes uncompared.
 */
export function parseManifest(text) {
  const out = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length !== 3) throw new Error(`unreadable manifest line: ${JSON.stringify(line)}`);
    const [table, columns, rows] = parts;
    if (!/^\d+$/.test(columns) || !/^\d+$/.test(rows)) {
      throw new Error(`non-numeric counts in manifest line: ${JSON.stringify(line)}`);
    }
    out.set(table, { columns: Number(columns), rows: Number(rows) });
  }
  return out;
}

/**
 * Every way the restored copy can differ from the source, as readable lines.
 *
 * Returns `[]` when they match. A missing table, an extra table, a lost column
 * and a lost row are all reported — an empty restore into an empty scratch
 * database compares "equal" under a naive check, and that is exactly the
 * outcome a drill exists to catch.
 */
export function compareManifests(source, restored) {
  const problems = [];
  for (const [table, before] of source) {
    const after = restored.get(table);
    if (!after) {
      problems.push(`${table}: missing from the restored copy`);
      continue;
    }
    if (after.columns !== before.columns) {
      problems.push(`${table}: ${before.columns} columns in source, ${after.columns} restored`);
    }
    if (after.rows !== before.rows) {
      problems.push(`${table}: ${before.rows} rows in source, ${after.rows} restored`);
    }
  }
  for (const table of restored.keys()) {
    if (!source.has(table)) problems.push(`${table}: present in the restore and not in the source`);
  }
  return problems;
}

/** Total rows, so "restored 0 rows successfully" cannot read as a pass. */
export function totalRows(manifest) {
  let total = 0;
  for (const { rows } of manifest.values()) total += rows;
  return total;
}

// ---------------------------------------------------------------------------
// Everything below talks to a database and is exercised only in CI, where a
// real Postgres exists. The logic above is exercised by --self-test.
// ---------------------------------------------------------------------------

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

/**
 * `table|columns|rows` for every table in schema public.
 *
 * Row counts are a real `count(*)` per table rather than `pg_class.reltuples`,
 * which is an estimate maintained by VACUUM and is routinely wrong by thousands
 * on a table that was just restored — it would let this pass while the data was
 * missing, which is the one outcome that must never happen quietly.
 */
function manifestOf(url) {
  const tables = run("psql", [
    url,
    "-At",
    "-c",
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  ])
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tables.length === 0) throw new Error(`${url} has no tables in schema public`);

  const lines = tables.map((table) => {
    const [columns, rows] = run("psql", [
      url,
      "-At",
      "-c",
      `SELECT (SELECT count(*) FROM information_schema.columns
                WHERE table_schema='public' AND table_name='${table}')
              || '|' || (SELECT count(*) FROM "${table}")`,
    ])
      .trim()
      .split("|");
    return `${table}|${columns}|${rows}`;
  });
  return parseManifest(lines.join("\n"));
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  const source = argv[argv.indexOf("--source") + 1];
  if (!source || source.startsWith("--")) {
    throw new Error("usage: restore-drill.mjs --source <postgres url> [--self-test]");
  }

  const scratch = assertSafeScratchName(`${SCRATCH_PREFIX}${Date.now()}`);
  const admin = new URL(source);
  const target = new URL(source);
  target.pathname = `/${scratch}`;
  // `postgres` rather than the source database: you cannot create a database
  // while connected to the one being copied on some managed providers.
  admin.pathname = "/postgres";

  const dir = mkdtempSync(join(tmpdir(), "godeye-drill-"));
  const dump = join(dir, "backup.dump");
  let created = false;

  try {
    process.stdout.write("reading the source manifest\n");
    const before = manifestOf(source);
    process.stdout.write(`  ${before.size} tables, ${totalRows(before)} rows\n`);

    process.stdout.write("dumping\n");
    const dumpStarted = Date.now();
    run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", dump, source]);
    const dumpSeconds = (Date.now() - dumpStarted) / 1000;

    process.stdout.write(`creating ${scratch}\n`);
    run("psql", [admin.toString(), "-c", `CREATE DATABASE "${scratch}"`]);
    created = true;

    process.stdout.write("restoring\n");
    const restoreStarted = Date.now();
    run("pg_restore", ["--no-owner", "--no-acl", "--dbname", target.toString(), dump]);
    const restoreSeconds = (Date.now() - restoreStarted) / 1000;

    process.stdout.write("comparing\n");
    const after = manifestOf(target.toString());
    const problems = compareManifests(before, after);

    if (problems.length) {
      process.stderr.write(`\nRESTORE DRILL FAILED\n\n${problems.join("\n")}\n\n`);
      process.exitCode = 1;
      return;
    }

    // The numbers are the point. An RTO nobody has measured is a guess, and
    // this is the only line in the repository that is not one.
    process.stdout.write(
      `\nRESTORE DRILL PASSED\n` +
        `  tables   ${before.size}\n` +
        `  rows     ${totalRows(before)}\n` +
        `  dump     ${dumpSeconds.toFixed(1)}s\n` +
        `  restore  ${restoreSeconds.toFixed(1)}s\n\n` +
        `Record these in docs/operations/DR.md. They are measurements, and every\n` +
        `other number in that document is arithmetic.\n`,
    );
  } finally {
    if (created) {
      try {
        run("psql", [admin.toString(), "-c", `DROP DATABASE "${assertSafeScratchName(scratch)}"`]);
      } catch (e) {
        // Reported, never swallowed: a scratch database left behind costs money
        // and will be found by somebody who does not know what it is.
        process.stderr.write(`could not drop ${scratch}: ${e.message}\n`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The comparison logic, checked without a database.
 *
 * Here because the orchestration above cannot run outside CI, and the
 * comparison is the half most likely to be quietly wrong — a drill that always
 * passes is worse than no drill, because it is believed.
 */
function selfTest() {
  const check = (name, fn) => {
    try {
      fn();
      process.stdout.write(`  ok  ${name}\n`);
    } catch (e) {
      process.stderr.write(`  FAIL  ${name}\n    ${e.message}\n`);
      process.exitCode = 1;
    }
  };
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  };
  const throws = (fn, m) => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(`${m}: expected a throw`);
  };

  process.stdout.write("restore-drill self test\n");

  check("parses a manifest", () => {
    const m = parseManifest("User|8|3\nOrganization|5|1");
    eq(m.get("User"), { columns: 8, rows: 3 }, "User");
    eq(m.size, 2, "size");
  });

  check("ignores blank lines and whitespace", () => {
    eq(parseManifest("\n  User|8|3  \n\n").size, 1, "size");
  });

  check("refuses a line it cannot read, rather than skipping it", () => {
    // A skipped line is a table that goes uncompared, which is the failure
    // this whole script exists to prevent.
    throws(() => parseManifest("User|8"), "short line");
    throws(() => parseManifest("User|eight|3"), "non-numeric");
  });

  check("reports nothing when the copy matches", () => {
    const a = parseManifest("User|8|3\nOrg|5|1");
    eq(compareManifests(a, parseManifest("Org|5|1\nUser|8|3")), [], "ordering must not matter");
  });

  check("catches a missing table", () => {
    const problems = compareManifests(parseManifest("User|8|3\nOrg|5|1"), parseManifest("User|8|3"));
    eq(problems.length, 1, "count");
    if (!problems[0].includes("Org")) throw new Error(problems[0]);
  });

  check("catches lost rows", () => {
    const problems = compareManifests(parseManifest("User|8|3"), parseManifest("User|8|0"));
    eq(problems.length, 1, "count");
    if (!problems[0].includes("3 rows in source, 0 restored")) throw new Error(problems[0]);
  });

  check("catches a lost column", () => {
    const problems = compareManifests(parseManifest("User|8|3"), parseManifest("User|7|3"));
    eq(problems.length, 1, "count");
  });

  check("catches a table the restore invented", () => {
    const problems = compareManifests(parseManifest("User|8|3"), parseManifest("User|8|3\nX|1|0"));
    eq(problems.length, 1, "count");
  });

  check("an empty restore does not read as a pass", () => {
    // The failure that matters most: restoring nothing into an empty database
    // compares "equal" under any check that only walks the restored side.
    const problems = compareManifests(parseManifest("User|8|3\nOrg|5|1"), parseManifest(""));
    eq(problems.length, 2, "count");
  });

  check("totalRows sums", () => eq(totalRows(parseManifest("User|8|3\nOrg|5|1")), 4, "total"));

  check("only drops a scratch database", () => {
    eq(assertSafeScratchName("restore_drill_123"), "restore_drill_123", "valid name");
    throws(() => assertSafeScratchName("postgres"), "postgres");
    throws(() => assertSafeScratchName("godeye"), "the real database");
    throws(() => assertSafeScratchName(""), "empty");
    throws(() => assertSafeScratchName(undefined), "undefined");
    throws(() => assertSafeScratchName("restore_drill_"), "prefix alone");
    throws(() => assertSafeScratchName('restore_drill_1"; DROP DATABASE godeye; --'), "injection");
  });

  if (!process.exitCode) process.stdout.write("\nall self tests passed\n");
}

main(process.argv.slice(2));
