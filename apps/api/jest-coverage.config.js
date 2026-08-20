/**
 * The coverage gate. Runs BOTH suites in one pass, on purpose.
 *
 * Measuring the unit suite alone would be actively misleading here, and by a
 * lot. `oauth-state.service.ts` reads as 21% covered under `jest` and is one of
 * the most heavily exercised files in the repository — all of it from
 * `s11-oauth-state-binding.exploit.spec.ts`, which runs under a different
 * config and so lands in a different coverage universe. Same story for
 * `roles.guard.ts`, `csrf.guard.ts`, `throttler.guard.ts` and
 * `membership.service.ts`: guards are wiring, wiring is only observable over
 * real HTTP, and real HTTP is what the exploit suite does.
 *
 * A gate that ignored that would push somebody to write duplicate unit tests
 * for behaviour the exploit suite already proves, purely to move a number. So:
 * `projects`, one merged report, one threshold.
 *
 * Not the default `pnpm test` for two reasons — instrumenting every file makes
 * the run several times slower, and the exploit suite is RED by design while a
 * finding is open, which must stay distinguishable from a regression.
 */
const unit = {
  displayName: "unit",
  rootDir: ".",
  moduleFileExtensions: ["js", "json", "ts"],
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  testEnvironment: "node",
};

const exploits = {
  ...require("./jest-exploits.config.js"),
  displayName: "exploits",
};

module.exports = {
  rootDir: ".",
  projects: [unit, exploits],

  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["text-summary", "json-summary", "lcov"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    // Composition roots and process entry points. main.ts cannot be imported
    // without listening on a socket, and a module file is a list of providers —
    // covering either measures nothing and would only be reached by tests
    // written to move the number.
    "!src/main.ts",
    "!src/**/*.module.ts",
    // Generated or vendored surface with no logic of ours in it.
    "!src/**/*.d.ts",
  ],

  /**
   * Thresholds are a RATCHET, not an aspiration.
   *
   * The remediation directive asks for 85% lines globally and 100% branch on
   * auth, authorization, billing and crypto. Neither is met today and neither is
   * claimed: see docs/audit/FINDINGS.md. What is set here is a floor a little
   * under the numbers the suites actually reach, so the gate does the one thing
   * a coverage gate is genuinely good at — refusing a change that makes things
   * worse — without becoming the aspirational number somebody eventually marks
   * `continue-on-error`.
   *
   * Raise these when the coverage rises. Never lower them to make a build pass;
   * that is the failure mode this file exists to prevent.
   */
  coverageThreshold: {
    global: {
      // NOTE, because this is not obvious and cost a confused ten minutes:
      // jest REMOVES any file with its own threshold below from the `global`
      // group. So `global` here describes everything *except* the
      // security-critical list, and raising coverage on url-guard.ts or
      // tokens.ts does not move these numbers by a single decimal. Two
      // separate ratchets, not one.
      lines: 65,
      statements: 65,
      branches: 49,
      functions: 55,
    },

    /**
     * The files where a gap is not a missing test but an unguarded door. Each
     * of these is at or near the level shown, so the threshold is a floor
     * rather than a target.
     *
     * Per-file rather than per-directory: a directory average lets a
     * well-tested neighbour carry an untested guard, which is exactly how S-1
     * survived a suite reporting 100% on roles.guard.ts while five controllers
     * never loaded it.
     */
    "./src/common/roles.guard.ts": { lines: 100, branches: 75 },
    "./src/common/csrf.guard.ts": { lines: 95, branches: 85 },
    "./src/common/jwt-auth.guard.ts": { lines: 90, branches: 70 },
    "./src/common/secrets.ts": { lines: 95, branches: 80 },
    "./src/common/tokens.ts": { lines: 100, branches: 90 },
    "./src/common/url-guard.ts": { lines: 90, branches: 65 },
    "./src/common/env.ts": { lines: 85, branches: 85 },
    "./src/connections/oauth-state.service.ts": { lines: 78, branches: 65 },
    "./src/auth/auth.service.ts": { lines: 72, branches: 60 },
    "./src/auth/login-backoff.service.ts": { lines: 95, branches: 85 },
  },
};
