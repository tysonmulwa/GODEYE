import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { AuthenticatedRequest } from "../common/jwt-auth.guard";
import { WorkspaceAccessService } from "./workspace-access.service";

/** Methods that only read. A locked workspace keeps all of them. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes that keep working while a workspace is locked.
 *
 * `/billing` is the important one: locking somebody out of the page that takes
 * their money would make the lock permanent. `/auth` covers signing out,
 * refreshing a session and changing a password, a payment problem is not a
 * reason to trap someone in their account. `/webhooks` carries no session at
 * all and is how a payment arrives in the first place.
 */
const OPEN_PREFIXES = ["/auth", "/billing", "/webhooks", "/health"];

/**
 * Read-only once the trial runs out unpaid.
 *
 * Registered globally (APP_INTERCEPTOR) rather than added to each controller on
 * purpose. There are fifteen controllers and more arrive with every feature;
 * an allow-list that has to be remembered is one forgotten decorator away from
 * a workspace that publishes for free forever. Here the default is closed and
 * the exceptions are written down above.
 *
 * It is an interceptor and not a guard because guards registered globally run
 * *before* the controller's own JwtAuthGuard, so `req.auth`, the only thing
 * that says which workspace is calling, would not exist yet. Interceptors run
 * after every guard, and throwing from one still refuses the request before the
 * handler is reached.
 */
@Injectable()
export class TrialLockInterceptor implements NestInterceptor {
  constructor(private readonly access: WorkspaceAccessService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    // WebSocket and other non-HTTP contexts have no method to judge.
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (READ_METHODS.has(req.method)) return next.handle();

    // Unauthenticated: there is no workspace to check, and the route's own
    // guard is about to reject it anyway.
    const orgId = req.auth?.orgId;
    if (!orgId) return next.handle();

    const path = req.path ?? req.url ?? "";
    if (OPEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      return next.handle();
    }

    const state = await this.access.state(orgId);
    if (state.locked) {
      throw new ForbiddenException({
        code: "WORKSPACE_LOCKED",
        message:
          "Your free trial has ended, so this workspace is read-only. " +
          "Choose a plan on the Billing page to start publishing again, " +
          "everything you have already made is still here.",
      });
    }
    return next.handle();
  }
}
