/**
 * The logger's scope, and how it must be fetched.
 *
 * The API crash-looped on boot in production:
 *
 *   InvalidClassScopeException: StructuredLogger is marked as a scoped
 *   provider. Request and transient-scoped providers can't be used in
 *   combination with "get()" method. Please, use "resolve()" instead.
 *
 * `main.ts` called `app.get(StructuredLogger)`. Nest refuses `get()` for
 * anything transient or request-scoped, because transient means there is no
 * single instance for it to return -- every injector gets its own.
 *
 * Nothing caught it because `bootstrap()` is not exercised by any unit test: it
 * builds a real application, binds a port and connects to a database. So this
 * asserts the invariant behind the call instead of the call itself -- if the
 * scope is transient, main.ts must use `resolve`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPE_OPTIONS_METADATA } from "@nestjs/common/constants";
import { Scope } from "@nestjs/common";
import { StructuredLogger } from "./logger";

const mainSource = readFileSync(join(__dirname, "..", "main.ts"), "utf8");

describe("StructuredLogger scope", () => {
  it("is transient, which is why get() cannot be used on it", () => {
    const options = Reflect.getMetadata(SCOPE_OPTIONS_METADATA, StructuredLogger) as
      | { scope?: Scope }
      | undefined;
    expect(options?.scope).toBe(Scope.TRANSIENT);
  });

  it("is fetched with resolve(), not get(), in main.ts", () => {
    expect(mainSource).toContain("await app.resolve(StructuredLogger)");
    expect(mainSource).not.toContain("app.get(StructuredLogger)");
  });

  /**
   * `resolve` returns a promise. Dropping the await hands useLogger a Promise
   * rather than a logger, which does not throw -- it silently produces an
   * application whose logging is broken, which is worse than the crash.
   */
  it("awaits the resolve", () => {
    const call = /app\.useLogger\(([^)]*)\)/.exec(mainSource)?.[1] ?? "";
    expect(call).toContain("await");
  });
});
