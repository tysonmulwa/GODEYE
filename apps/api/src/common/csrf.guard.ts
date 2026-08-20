import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { allowedOrigins, toOrigin } from "./env";
import { csrfBlocked } from "./metrics";

/**
 * Cross-site request forgery, finding S-14.
 *
 * `/auth/refresh` and `/auth/logout` are authenticated by the refresh cookie
 * alone, and both are `@Public()` because there is no access token to present
 * — that is the whole point of a refresh endpoint. When WEB_URL and API_URL
 * are on different registrable domains the cookie has to be `SameSite=None`,
 * and at that point any page on the internet can do this:
 *
 *     <form action="https://api.godeyeautomation.com/auth/logout" method="POST">
 *     <script>document.forms[0].submit()</script>
 *
 * A POST with no body and no custom header is a CORS *simple request*: there
 * is no preflight, the browser attaches the cookie, and the server executes
 * it. CORS withholds the *response* from the attacker, which is why this is
 * easy to dismiss — but the side effect has already happened. `/auth/logout`
 * ends the session. `/auth/refresh` rotates the token, and because rotation
 * carries reuse detection, a forced rotation racing the real tab trips the
 * reuse alarm and revokes the entire session family.
 *
 * The same shape covers login CSRF on `/auth/login` and
 * `/auth/accept-invitation`: the attacker submits *their own* credentials, the
 * victim's browser accepts the resulting session cookie, and the victim then
 * works inside the attacker's workspace — composing, connecting accounts and
 * uploading media that the attacker can read.
 *
 * ## The rule
 *
 * Unsafe method, no bearer token, not exempt ⇒ the request must carry an
 * `Origin` (or `Referer`) on the allow-list. One rule, applied globally, with
 * no per-route judgement to get wrong — the same reasoning that made
 * RolesGuard global after S-1.
 *
 * Three escapes, each with a reason rather than a convenience:
 *
 *   - **Safe methods.** GET/HEAD/OPTIONS change nothing. A GET that does
 *     change something is a separate defect, and the route audit is where that
 *     gets caught.
 *   - **`Authorization: Bearer`.** An attacker's page cannot set that header
 *     cross-origin without a preflight, and the preflight is answered by the
 *     CORS allow-list — the same list this guard uses. A request holding a
 *     bearer token is either same-origin, from an approved origin, or not from
 *     a browser at all, and in the last case the attacker needed the token
 *     anyway, which is not forgery.
 *   - **`@CsrfExempt(reason)`.** For endpoints authenticated by a signature
 *     rather than by ambient credentials — the Meta and Paystack webhooks.
 *     They are server-to-server, so they have no Origin to offer and never
 *     will. The set of exempt routes is asserted against a checked-in list in
 *     the exploit suite, so a new exemption cannot be added quietly.
 *
 * Absent Origin **and** absent Referer is a denial, not a pass. That is the
 * fail-closed rule: a check that cannot establish where a request came from
 * has not established that it is safe. It does mean a non-browser client
 * calling `/auth/login` must send an `Origin` header — documented in
 * docs/security/CSRF.md, and one line for such a caller.
 *
 * OWASP ASVS 5.0 V4.2.2, CWE-352, OWASP API Security Top 10 API8:2023.
 */

export const CSRF_EXEMPT_KEY = "csrfExempt";

/**
 * Marks a route as authenticated by something other than an ambient browser
 * credential. The reason is required and is read back by the exploit suite, so
 * "why is this exempt" is answerable without archaeology.
 */
export const CsrfExempt = (reason: string) => SetMetadata(CSRF_EXEMPT_KEY, reason);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A bearer token, not merely the word "Bearer" — an empty one proves nothing. */
const BEARER = /^Bearer\s+\S/i;

export type CsrfReason = "safe-method" | "exempt" | "bearer" | "origin-allowed";
export type CsrfDenial = "no-origin" | "foreign-origin";

export type CsrfDecision =
  | { allow: true; because: CsrfReason }
  | { allow: false; because: CsrfDenial; origin: string | null };

/**
 * The whole decision, as a pure function.
 *
 * Separated from the guard so it can be tested against a table of inputs
 * rather than through a booted Nest application. A security decision that is
 * awkward to test is a security decision that goes untested.
 */
export function decideCsrf(input: {
  method: string;
  exempt: boolean;
  authorization?: string;
  origin?: string;
  referer?: string;
  allowed: string[];
}): CsrfDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return { allow: true, because: "safe-method" };
  }
  if (input.exempt) return { allow: true, because: "exempt" };
  if (BEARER.test(input.authorization ?? "")) return { allow: true, because: "bearer" };

  // Referer only as a fallback. It is stripped by privacy tooling and by
  // Referrer-Policy, so requiring it would break real clients — but when it is
  // present it is set by the browser and cannot be forged by page script, the
  // same property that makes Origin usable.
  const origin = toOrigin(input.origin) ?? toOrigin(input.referer);
  if (!origin) return { allow: false, because: "no-origin", origin: null };
  if (!input.allowed.includes(origin)) {
    return { allow: false, because: "foreign-origin", origin };
  }
  return { allow: true, because: "origin-allowed" };
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // The Socket.IO gateway authorizes itself; a global HTTP guard must not
    // pass judgement on a protocol whose headers it is not reading.
    if (context.getType() !== "http") return true;

    const req = context.switchToHttp().getRequest<Request>();
    const exempt = this.reflector.getAllAndOverride<string | undefined>(CSRF_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const decision = decideCsrf({
      method: req.method,
      exempt: Boolean(exempt),
      authorization: req.headers.authorization,
      origin: req.headers.origin,
      referer: req.headers.referer,
      allowed: allowedOrigins(),
    });

    if (decision.allow) return true;

    // Counted, because the difference between "an attack" and "WEB_URL is
    // wrong" is a rate, and neither is visible from a 403 in a log line.
    csrfBlocked.add(1, { reason: decision.because });

    // Says which header to send and does not echo the rejected origin back
    // into the response, so the message cannot be used to probe the allow-list.
    throw new ForbiddenException(
      "Cross-site request blocked. State-changing requests must carry an " +
        "Authorization: Bearer header or an Origin header from an allowed site.",
    );
  }
}
