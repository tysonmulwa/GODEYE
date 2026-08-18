/**
 * One-command dev launcher: starts the Node apps (web + api via turbo) AND the
 * Python automation engine (FastAPI + Celery worker + beat) together, so
 * `pnpm dev` brings up the whole stack.
 *
 * The engine is a separate Python project (not a pnpm workspace member), so it
 * can't be started by turbo, this launcher bridges that. If the engine's venv
 * isn't set up, it's skipped with a hint and web+api still run.
 *
 * Prerequisites for the engine to actually do work: Redis running, and an
 * ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env for content generation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = platform() === "win32";
const venvPython = isWin
  ? join(root, "apps", "engine", ".venv", "Scripts", "python.exe")
  : join(root, "apps", "engine", ".venv", "bin", "python");

const procs = [];

function spawnProc(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: root, shell: isWin, ...opts });
  procs.push(p);
  return p;
}

// web + api, turbo already labels its own output per app
spawnProc("pnpm", ["exec", "turbo", "run", "dev", "--parallel"], { stdio: "inherit" });

// engine (Python), only when its venv exists
if (existsSync(venvPython)) {
  const engine = spawnProc(venvPython, ["-m", "godeye_engine.run"], {
    cwd: join(root, "apps", "engine"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const relay = (buf) =>
    buf
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.log(`\x1b[35m[engine]\x1b[0m ${line}`));
  engine.stdout.on("data", relay);
  engine.stderr.on("data", relay);
} else {
  console.log(`\x1b[35m[engine]\x1b[0m skipped, no Python venv at ${venvPython}`);
  console.log(
    `\x1b[35m[engine]\x1b[0m set it up:  cd apps/engine && python -m venv .venv && ` +
      `${isWin ? ".venv\\Scripts\\activate" : "source .venv/bin/activate"} && pip install -e ".[dev]"`,
  );
}

function shutdown() {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
