import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { CSRF_EXEMPT_KEY } from "./csrf.guard";
import { MIN_ROLE_KEY } from "./roles.guard";
import { PUBLIC_KEY } from "./public.decorator";

/** Nest's RequestMethod enum, in its declared order. */
const METHOD_NAMES = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];

export interface RouteRecord {
  controller: string;
  handler: string;
  method: string;
  path: string;
  access: "public" | "VIEWER" | "EDITOR" | "ADMIN" | "OWNER" | "UNANNOTATED";
  /**
   * The stated reason this route is excused from the CSRF origin check (S-14),
   * or null. Carried here rather than checked separately so the exempt set is
   * enumerable — a security exception nobody can list is a security exception
   * nobody reviews.
   */
  csrfExempt: string | null;
}

/**
 * Enumerates every registered route at startup and refuses to boot if one
 * declares no access level.
 *
 * This is the structural half of the S-1 fix. RolesGuard denies an unannotated
 * route at request time, which is correct but invisible: the route would 403
 * in production and somebody would "fix" it by loosening the guard. Failing the
 * boot, by name, means a route added without an access decision never reaches a
 * deploy at all.
 *
 * The same enumeration feeds the authorization matrix test, so a new route
 * without a matrix entry fails CI rather than shipping unreviewed.
 */
@Injectable()
export class RouteAuditService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteAuditService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    const routes = this.collect();
    const unannotated = routes.filter((r) => r.access === "UNANNOTATED");
    if (unannotated.length) {
      const list = unannotated
        .map((r) => `  - ${r.method} /${r.path} (${r.controller}.${r.handler})`)
        .join("\n");
      throw new Error(
        `Refusing to start: ${unannotated.length} route(s) declare no access level.\n${list}\n\n` +
          `Every route must carry @Public() or @MinRole(...). See docs/security/AUTHORIZATION.md.`,
      );
    }
    this.logger.log(
      `${routes.length} routes, all annotated ` +
        `(${routes.filter((r) => r.access === "public").length} public)`,
    );

    // Named in the boot log, not merely counted. These are the routes a
    // cross-site page can reach, and the deploy log is where somebody notices
    // that the list grew.
    const exempt = routes.filter((r) => r.csrfExempt);
    for (const route of exempt) {
      this.logger.log(`CSRF-exempt: ${route.method} /${route.path} — ${route.csrfExempt}`);
    }
  }

  /** Every HTTP route Nest has registered, with the access level it declares. */
  collect(): RouteRecord[] {
    const out: RouteRecord[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      const base = String(Reflect.getMetadata(PATH_METADATA, wrapper.metatype ?? {}) ?? "");

      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = (instance as Record<string, () => unknown>)[name];
        const path = Reflect.getMetadata(PATH_METADATA, handler);
        if (path === undefined) continue; // not a route handler

        const methodIndex = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        // A handler may declare several paths (@Get(["a", "b"])).
        for (const one of Array.isArray(path) ? path : [path]) {
          out.push({
            controller: wrapper.metatype?.name ?? "unknown",
            handler: name,
            method: METHOD_NAMES[methodIndex ?? 0] ?? "GET",
            path: [base, String(one)].filter(Boolean).join("/").replace(/\/+/g, "/"),
            access: this.accessOf(handler, wrapper.metatype),
            csrfExempt:
              (Reflect.getMetadata(CSRF_EXEMPT_KEY, handler as object) as string | undefined) ??
              (Reflect.getMetadata(CSRF_EXEMPT_KEY, wrapper.metatype ?? {}) as
                | string
                | undefined) ??
              null,
          });
        }
      }
    }
    return out.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  }

  private accessOf(handler: unknown, controller: unknown): RouteRecord["access"] {
    const read = (key: string) =>
      (Reflect.getMetadata(key, handler as object) ??
        Reflect.getMetadata(key, controller as object)) as unknown;
    if (read(PUBLIC_KEY) === true) return "public";
    const role = read(MIN_ROLE_KEY);
    if (typeof role === "string") return role as RouteRecord["access"];
    return "UNANNOTATED";
  }
}
