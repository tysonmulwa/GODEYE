import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { AuthenticatedRequest, JwtAuthGuard } from "./jwt-auth.guard";
import { PUBLIC_KEY } from "./public.decorator";
import { MembershipService } from "./membership.service";

export type OrgRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

export const ROLE_RANK: Record<OrgRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  EDITOR: 2,
  VIEWER: 1,
};

export const MIN_ROLE_KEY = "minRole";

/** Route requires the caller's org role to be at least `role` (OWNER > ADMIN > EDITOR > VIEWER). */
export const MinRole = (role: OrgRole) => SetMetadata(MIN_ROLE_KEY, role);

export function roleAtLeast(role: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * The single authorization gate for every HTTP route, registered globally.
 *
 * It used to be a per-controller guard, and finding S-1 is what that cost:
 * connections, media, seo, products and business-profile declared
 * `@UseGuards(JwtAuthGuard)` and nothing else, so a VIEWER — the role the
 * product sells as read-only — could delete every social connection, attach an
 * attacker's Telegram bot, burn AI spend, overwrite the brand kit, wipe the
 * catalogue and delete every SEO audit.
 *
 * The worse half was the trap: adding `@MinRole("ADMIN")` to any of those five
 * compiled, read correctly in review, and enforced nothing, because the guard
 * that reads the metadata was not in the chain. Per-controller wiring is a
 * decision every future developer has to get right; global registration is a
 * decision made once.
 *
 * Three rules:
 *   1. `@Public()` — open, and said so out loud.
 *   2. `@MinRole(x)` — authenticate, then require rank >= x.
 *   3. neither — deny. RouteAuditService additionally refuses to boot, so this
 *      branch should be unreachable in a shipped build.
 *
 * OWASP ASVS V8; API Security Top 10 API1/API5.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly jwtGuard: JwtAuthGuard;

  constructor(
    private readonly reflector: Reflector,
    jwt: JwtService,
    private readonly memberships: MembershipService,
  ) {
    this.jwtGuard = new JwtAuthGuard(jwt);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP contexts (the Socket.IO gateway) authorize themselves; a global
    // HTTP guard must not silently pass judgement on a protocol it cannot read.
    if (context.getType() !== "http") return true;

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<OrgRole | undefined>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Authenticate first either way: an unannotated route must answer 403 to a
    // caller who is genuinely a member, not leak that it exists to everyone.
    await this.jwtGuard.canActivate(context);

    if (!required) {
      throw new ForbiddenException(
        "This route declares no access level. It is denied by default; annotate it " +
          "with @Public() or @MinRole().",
      );
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { auth } = req;
    // Missing role is never "allow". This is the fail-closed rule from §1.8: a
    // check that cannot establish authorization denies.
    if (!auth?.role) throw new ForbiddenException(`Requires ${required} role or higher`);

    // The live membership, not the bearer's copy of it (S-10). A demoted ADMIN
    // used to keep ADMIN for the life of their 15-minute token, and a removed
    // member kept full access long enough to delete every connection.
    const live = await this.memberships.current(auth.sub, auth.orgId);
    if (!live) {
      throw new UnauthorizedException("You are no longer a member of this workspace");
    }
    if (live.sessionVersion !== (auth.sv ?? 0)) {
      // A password change, an MFA change, a role change, or "sign out
      // everywhere" happened after this token was minted.
      throw new UnauthorizedException("This session has ended. Sign in again.");
    }

    // The request sees the role the database holds, so a handler that reads
    // req.auth.role cannot act on a stale one either.
    auth.role = live.role;
    if (!roleAtLeast(live.role, required)) {
      throw new ForbiddenException(`Requires ${required} role or higher`);
    }
    return true;
  }
}
