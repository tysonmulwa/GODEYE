import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticatedRequest } from "./jwt-auth.guard";

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
 * Enforces @MinRole() using the role already embedded in the access token.
 * Must run after JwtAuthGuard (which populates req.auth).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<OrgRole | undefined>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!auth || !roleAtLeast(auth.role, required)) {
      throw new ForbiddenException(`Requires ${required} role or higher`);
    }
    return true;
  }
}
