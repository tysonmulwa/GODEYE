#!/usr/bin/env node
/**
 * Does Railway agree with the deploy config in this repository?
 *
 *     node scripts/railway-drift.mjs
 *     node scripts/railway-drift.mjs --self-test   # logic only, no API
 *
 * Written after an outage that no test in this repository could have caught,
 * because the value that caused it was never in this repository.
 *
 * `engine-worker` had a `preDeployCommand` set in the Railway dashboard, and
 * that command was the Celery worker itself:
 *
 *     celery -A godeye_engine.celery_app worker --beat ... --concurrency=2
 *
 * A pre-deploy command has to EXIT before Railway starts the real process. A
 * Celery worker never exits. So every deploy of engine-worker stopped at the
 * pre-deploy step and sat there -- three of them were still "Deploying", with
 * containers up, hours later. A deployment stuck in a non-terminal state holds
 * the environment's deploy slot, so the newest deployment of the API, the
 * engine and beat all queued behind it and no commit reached production for
 * most of a day. Nothing failed. Nothing went red. The dashboard showed
 * "Queued" and the old containers kept serving.
 *
 * apps/engine/tests/test_railway_config.py already checks these files parse and
 * say sensible things, and it was green throughout, correctly: the files were
 * fine. `preDeployCommand` appeared in none of them. It existed only in
 * Railway's own settings, where no reviewer, diff or test could see it.
 *
 * This closes that gap by asking Railway what it is actually running.
 * `resolvedFileConfig.propertyFileMapping` reports, per property, whether the
 * value came from the config file, which makes dashboard-set settings visible:
 *
 *   HANGS        a pre-deploy command that looks like a long-running process.
 *                Not a slow deploy: a deploy that never ends, and takes the
 *                environment's other services down with it.
 *   UNDECLARED   set in the dashboard, absent from the config file. Governs the
 *                deploy, is reviewed by nobody. This is the outage above.
 *   CONTRADICTED set in both, disagreeing. The file wins, so the dashboard is
 *                showing somebody a command that is not the one running.
 *   MISSING      Railway is reading a config file this checkout does not have.
 *   SHADOWED     set in both, agreeing. Harmless today, and advisory only --
 *                but it is one edit away from CONTRADICTED. engine-worker kept
 *                a `--beat` start command here long after the file dropped it,
 *                which is a second scheduler waiting to happen.
 *
 * Needs to authenticate, and says so rather than passing quietly -- a drift
 * check that skips itself when it cannot authenticate reports "no drift" for
 * the exact state it was written to catch. Either of:
 *
 *     RAILWAY_API_TOKEN     account or workspace token (railway.com/account/tokens)
 *     RAILWAY_PROJECT_TOKEN project token, scoped to one environment
 *
 * or, with none set, the `railway` CLI's own session if you are logged in --
 * which locally you already are, and which keeps a long-lived token out of
 * everyone's shell profile.
 *
 * Exit 0 clean, 1 on drift, 2 if it could not look.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENDPOINT = "https://backboard.railway.com/graphql/v2";

/** Sentinel: no token, so go through the logged-in CLI instead of fetch. */
const USE_CLI = Symbol("railway-cli");

/**
 * Railway property name -> the key it has inside a railway.json `deploy` or
 * `build` block. Only properties a service can actually be configured with in
 * both places; anything Railway grows later shows up as UNDECLARED, which is
 * the safe direction to be wrong in.
 *
 * `always` marks the fields Railway declares non-null in its schema. They come
 * back with a value whether or not anyone set one, so for those "has a value"
 * does not mean "somebody configured this", and only a genuine disagreement
 * with the file is worth saying out loud. Reporting the platform's own defaults
 * as drift on every service is how a checker earns its way into the ignored
 * pile.
 */
const PROPERTIES = {
  "deploy.startCommand": { field: "startCommand", block: "deploy" },
  "deploy.preDeployCommand": { field: "preDeployCommand", block: "deploy" },
  "deploy.healthcheckPath": { field: "healthcheckPath", block: "deploy" },
  "deploy.healthcheckTimeout": { field: "healthcheckTimeout", block: "deploy" },
  "deploy.restartPolicyType": { field: "restartPolicyType", block: "deploy", always: true },
  "deploy.restartPolicyMaxRetries": {
    field: "restartPolicyMaxRetries",
    block: "deploy",
    always: true,
  },
  "deploy.cronSchedule": { field: "cronSchedule", block: "deploy" },
  "build.buildCommand": { field: "buildCommand", block: "build" },
  "build.dockerfilePath": { field: "dockerfilePath", block: "build" },
};

/**
 * Things that do not exit. A pre-deploy command matching one of these is the
 * failure this script exists for, so it is named rather than merely reported.
 */
const NEVER_EXITS = [
  { pattern: /\bcelery\b[\s\S]*\bworker\b/, what: "a Celery worker" },
  { pattern: /\bcelery\b[\s\S]*\bbeat\b/, what: "a Celery beat scheduler" },
  { pattern: /\buvicorn\b/, what: "a uvicorn server" },
  { pattern: /\bgunicorn\b/, what: "a gunicorn server" },
  { pattern: /\bnext\s+start\b/, what: "a Next.js server" },
  { pattern: /\bnode\b[\s\S]*\bmain\.js\b/, what: "the API server" },
];

/** SHADOWED is advisory; everything else fails the run. */
const ADVISORY = new Set(["SHADOWED"]);
const ORDER = { HANGS: 0, UNDECLARED: 1, CONTRADICTED: 2, MISSING: 3, SHADOWED: 4 };

const QUERY = `
  query DriftCheck($environmentId: String!) {
    environment(id: $environmentId) {
      name
      serviceInstances {
        edges {
          node {
            serviceName
            railwayConfigFile
            startCommand
            preDeployCommand
            buildCommand
            healthcheckPath
            healthcheckTimeout
            cronSchedule
            restartPolicyType
            restartPolicyMaxRetries
            dockerfilePath
            resolvedFileConfig {
              configFile
              commitHash
              propertyFileMapping
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// The analysis. Pure, so --self-test can drive it with the state production was
// actually in, rather than asserting that a mock was called.
// ---------------------------------------------------------------------------

/** Empty string, empty array and empty object all mean "not set" here. */
export function isSet(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Railway holds pre-deploy as a list; a railway.json may hold a bare string. */
function normalise(value) {
  return Array.isArray(value) ? value.join(" && ") : String(value);
}

/**
 * @param instances service instances as Railway reports them
 * @param loadConfig (configFile) => { relative, config } | { relative, error }
 */
export function analyse(instances, loadConfig) {
  const findings = [];
  let checked = 0;

  for (const instance of instances) {
    const configFile = instance.railwayConfigFile || instance.resolvedFileConfig?.configFile;
    // An image-only service (Redis) has no config file and nothing to drift from.
    if (!configFile) continue;

    const service = instance.serviceName;
    const { relative, config, error } = loadConfig(configFile);
    if (error) {
      findings.push({
        service,
        kind: "MISSING",
        detail:
          `Railway is reading ${relative}, which this checkout cannot: ${error.message}.\n` +
          `      Either the file moved without the service being updated, or the service` +
          ` points at a path that never existed.`,
      });
      continue;
    }

    checked += 1;
    const fromFile = instance.resolvedFileConfig?.propertyFileMapping ?? {};

    for (const [property, { field, block, always }] of Object.entries(PROPERTIES)) {
      const dashboardValue = instance[field];
      if (!isSet(dashboardValue)) continue;

      const fileValue = config?.[block]?.[field];
      const declared = property in fromFile;

      // A non-null field with no file declaration is the platform default, not
      // something a person chose in the dashboard, and there is no way to tell
      // the two apart from here.
      if (always && !declared) continue;

      if (!declared) {
        findings.push({
          service,
          kind: "UNDECLARED",
          detail:
            `${property} is set in the Railway dashboard and absent from ${relative}:\n` +
            `        ${normalise(dashboardValue)}\n` +
            `      It governs the deploy and appears in no diff. Add it to ${relative},` +
            ` or clear it in the dashboard.`,
        });
        continue;
      }

      const same = normalise(dashboardValue) === normalise(fileValue);
      if (same && always) continue;
      findings.push({
        service,
        kind: same ? "SHADOWED" : "CONTRADICTED",
        detail: same
          ? `${property} is set in both the dashboard and ${relative}, to the same value.\n` +
            `      Harmless today. Clear the dashboard field so the file stays the only` +
            ` place it is written.`
          : `${property} disagrees. The file wins, so the dashboard is showing a\n` +
            `      command that is not the one running:\n` +
            `        dashboard: ${normalise(dashboardValue)}\n` +
            `        ${relative}: ${normalise(fileValue)}`,
      });
    }

    // The one that stops the whole environment rather than one service.
    for (const source of [
      { label: "the Railway dashboard", value: instance.preDeployCommand },
      { label: relative, value: config?.deploy?.preDeployCommand },
    ]) {
      if (!isSet(source.value)) continue;
      const command = normalise(source.value);
      const match = NEVER_EXITS.find(({ pattern }) => pattern.test(command));
      if (!match) continue;
      findings.push({
        service,
        kind: "HANGS",
        detail:
          `preDeployCommand in ${source.label} starts ${match.what}:\n` +
          `        ${command}\n` +
          `      A pre-deploy command must exit before the service starts, and that` +
          ` one does not.\n` +
          `      The deploy will sit in "Deploying" forever and hold the environment's` +
          ` deploy\n      slot, queueing every other service behind it.`,
      });
    }
  }

  findings.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.service.localeCompare(b.service));
  return { findings, checked };
}

// ---------------------------------------------------------------------------
// Talking to Railway.
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`railway-drift: ${message}`);
  process.exit(2);
}

/** The CLI is already authenticated; borrow its session rather than a token. */
function graphqlViaCli(query, variables) {
  try {
    const stdout = execFileSync(
      "railway",
      ["api", query, "--variables", JSON.stringify(variables), "--compact", "--allow-errors"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout);
  } catch (error) {
    return fail(
      `no API token set, and the railway CLI could not answer: ${error.message.split("\n")[0]}.\n` +
        "  Run `railway login`, or set RAILWAY_API_TOKEN.",
    );
  }
}

async function graphql(query, variables, headers) {
  let body;
  if (headers === USE_CLI) {
    body = graphqlViaCli(query, variables);
  } else {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After") ?? "?";
      fail(`rate limited by the Railway API; retry after ${retry}s`);
    }
    body = await response.json().catch(() => null);
    if (!body) fail(`Railway API returned HTTP ${response.status} and no JSON body`);
  }
  // A GraphQL API returns 200 with an errors array, authorization denials
  // included, so the status code alone proves nothing.
  if (body.errors?.length) {
    const first = body.errors[0];
    fail(`Railway API: ${first.message} (traceId ${first.extensions?.traceId ?? "none"})`);
  }
  return body.data;
}

/** `/apps/engine/railway.worker.json` as Railway spells it -> the file on disk. */
function loadConfigFromDisk(configFile) {
  const relative = configFile.replace(/^\/+/, "");
  try {
    return { relative, config: JSON.parse(readFileSync(join(ROOT, relative), "utf8")) };
  } catch (error) {
    return { relative, error };
  }
}

function auth() {
  const projectToken = process.env.RAILWAY_PROJECT_TOKEN;
  if (projectToken) return { "Project-Access-Token": projectToken };
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
  if (token) return { Authorization: `Bearer ${token}` };
  return USE_CLI;
}

async function resolveEnvironmentId(headers) {
  if (process.env.RAILWAY_ENVIRONMENT_ID) return process.env.RAILWAY_ENVIRONMENT_ID;
  if (process.env.RAILWAY_PROJECT_TOKEN) {
    const data = await graphql(`query { projectToken { environmentId } }`, {}, headers);
    if (data?.projectToken?.environmentId) return data.projectToken.environmentId;
  }
  return fail(
    "no environment to check. Set RAILWAY_ENVIRONMENT_ID (Cmd/Ctrl+K in the\n" +
      "  project copies it), or use a project token, which carries its own.",
  );
}

function report(environmentName, { findings, checked }) {
  console.log(`railway-drift: ${environmentName}, ${checked} service(s) with a config file\n`);
  for (const finding of findings) {
    console.log(`  ${finding.kind.padEnd(12)} ${finding.service}: ${finding.detail}\n`);
  }
  if (findings.length === 0) {
    console.log("  Railway is running what this repository says. No drift.");
    return 0;
  }
  const blocking = findings.filter((finding) => !ADVISORY.has(finding.kind));
  console.log(`${blocking.length} blocking, ${findings.length - blocking.length} advisory.`);
  return blocking.length > 0 ? 1 : 0;
}

async function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  const headers = auth();
  const environmentId = await resolveEnvironmentId(headers);
  const data = await graphql(QUERY, { environmentId }, headers);
  const environment = data?.environment;
  if (!environment) fail(`environment ${environmentId} not found, or the token cannot see it`);

  const instances = environment.serviceInstances.edges.map((edge) => edge.node);
  if (instances.length === 0) fail(`environment ${environment.name} reports no services`);

  process.exitCode = report(environment.name, analyse(instances, loadConfigFromDisk));
}

// ---------------------------------------------------------------------------
// Self test. The fixtures are the real shapes: production as it stood during
// the outage, and as it stands now.
// ---------------------------------------------------------------------------

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

  const WORKER_FILE = "/apps/engine/railway.worker.json";
  const workerConfig = {
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/engine/Dockerfile" },
    deploy: {
      startCommand:
        "celery -A godeye_engine.celery_app worker -Q background,publish,media" +
        " --loglevel=info --concurrency=2 --max-tasks-per-child=50",
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  };
  const loader = (configFile) =>
    configFile === WORKER_FILE
      ? { relative: "apps/engine/railway.worker.json", config: workerConfig }
      : { relative: configFile.slice(1), error: new Error("ENOENT") };

  /** engine-worker exactly as Railway reported it during the outage. */
  const brokenWorker = {
    serviceName: "engine-worker",
    railwayConfigFile: WORKER_FILE,
    startCommand:
      "celery -A godeye_engine.celery_app worker --beat --schedule=/tmp/celerybeat-schedule" +
      " --loglevel=info --concurrency=2 --max-tasks-per-child=50",
    preDeployCommand: [
      "celery -A godeye_engine.celery_app worker --beat --schedule=/tmp/celerybeat-schedule" +
        " --loglevel=info --concurrency=2 --max-tasks-per-child=50",
    ],
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 10,
    resolvedFileConfig: {
      configFile: WORKER_FILE,
      commitHash: "065bac79",
      // The mapping as Railway actually returned it: no preDeployCommand. That
      // absence is the whole signal.
      propertyFileMapping: {
        "build.builder": "$.build.builder",
        "build.dockerfilePath": "$.build.dockerfilePath",
        "deploy.restartPolicyMaxRetries": "$.deploy.restartPolicyMaxRetries",
        "deploy.restartPolicyType": "$.deploy.restartPolicyType",
        "deploy.startCommand": "$.deploy.startCommand",
      },
    },
  };

  const kinds = (instance) =>
    analyse([instance], loader).findings.map((f) => `${f.kind}:${f.service}`);

  process.stdout.write("railway-drift self test\n");

  check("catches the pre-deploy command that hung every deploy", () => {
    const found = analyse([brokenWorker], loader).findings;
    const hangs = found.find((f) => f.kind === "HANGS");
    if (!hangs) throw new Error(`no HANGS finding in ${JSON.stringify(kinds(brokenWorker))}`);
    if (!hangs.detail.includes("a Celery worker")) throw new Error(hangs.detail);
  });

  check("calls the dashboard-only setting undeclared", () => {
    const found = analyse([brokenWorker], loader).findings;
    const undeclared = found.filter((f) => f.kind === "UNDECLARED");
    eq(undeclared.length, 1, "count");
    if (!undeclared[0].detail.includes("deploy.preDeployCommand")) {
      throw new Error(undeclared[0].detail);
    }
  });

  check("catches the second scheduler the file had already dropped", () => {
    // The dashboard kept `--beat` after railway.worker.json removed it. The
    // file wins, so this never fired twice -- but nothing said the two
    // disagreed, and the dashboard is where people look.
    const contradicted = analyse([brokenWorker], loader).findings.filter(
      (f) => f.kind === "CONTRADICTED",
    );
    eq(contradicted.length, 1, "count");
    if (!contradicted[0].detail.includes("--beat")) throw new Error(contradicted[0].detail);
  });

  check("fails the run on the broken state", () => {
    const { findings } = analyse([brokenWorker], loader);
    const blocking = findings.filter((f) => !ADVISORY.has(f.kind));
    if (blocking.length === 0) throw new Error("outage state would have exited 0");
  });

  check("passes once the dashboard is cleared", () => {
    const fixed = {
      ...brokenWorker,
      startCommand: workerConfig.deploy.startCommand,
      preDeployCommand: [],
    };
    const { findings } = analyse([fixed], loader);
    const blocking = findings.filter((f) => !ADVISORY.has(f.kind));
    eq(blocking, [], "no blocking findings once the dashboard agrees");
  });

  check("still names a start command left in both places", () => {
    // Advisory, not blocking: it is correct today and one edit from wrong.
    const fixed = {
      ...brokenWorker,
      startCommand: workerConfig.deploy.startCommand,
      preDeployCommand: [],
    };
    eq(kinds(fixed), ["SHADOWED:engine-worker"], "kinds");
  });

  check("says nothing about a service with no config file", () => {
    const redis = { serviceName: "Redis", railwayConfigFile: null, restartPolicyType: "ALWAYS" };
    const { findings, checked } = analyse([redis], loader);
    eq(findings, [], "findings");
    eq(checked, 0, "checked");
  });

  check("does not report the platform's own restart-policy defaults", () => {
    const plain = {
      serviceName: "engine-worker",
      railwayConfigFile: WORKER_FILE,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      resolvedFileConfig: { configFile: WORKER_FILE, propertyFileMapping: {} },
    };
    eq(kinds(plain), [], "a service configured entirely by its file is quiet");
  });

  check("reports a config file Railway reads and the repo does not have", () => {
    const moved = {
      serviceName: "engine-api",
      railwayConfigFile: "/apps/engine/railway.json",
      resolvedFileConfig: { configFile: "/apps/engine/railway.json", propertyFileMapping: {} },
    };
    eq(kinds(moved), ["MISSING:engine-api"], "kinds");
  });

  check("treats an empty pre-deploy list as unset", () => {
    eq(isSet([]), false, "empty array");
    eq(isSet(["celery"]), true, "populated array");
    eq(isSet("  "), false, "blank string");
  });

  if (process.exitCode) process.stderr.write("\nself test FAILED\n");
  return process.exitCode ?? 0;
}

await main(process.argv.slice(2));
