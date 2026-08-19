import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { verifyToken } from "./tokens";

export interface AccessTokenPayload {
  sub: string; // user id
  orgId: string;
  role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
  /**
   * The membership's sessionVersion when this token was minted. RolesGuard
   * compares it against the live row, so bumping the row retires every token
   * issued before the bump (S-10).
   *
   * Optional only so tokens issued by the previous release keep working through
   * one rotation; the guard treats a missing value as version 0.
   */
  sv?: number;
}

export interface AuthenticatedRequest extends Request {
  auth: AccessTokenPayload;
}

/**
 * Authenticates a request from a bearer access token.
 *
 * This guard used to verify signature and expiry and nothing else, which is
 * finding C-1: an OAuth `state` token — signed with the same key, and designed
 * to travel through Meta, TikTok, LinkedIn and Reddit — passed it, and
 * POST /auth/switch-org would then mint a full session from it.
 *
 * verifyToken() closes that four ways at once: a different key for state
 * tokens, an explicit `typ: "access"` claim, `iss`/`aud` validation, and an
 * HS256 allow-list so a forged header cannot choose the algorithm.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing access token");
    }
    let claims: AccessTokenPayload;
    try {
      claims = await verifyToken<AccessTokenPayload>(this.jwt, "access", header.slice(7));
    } catch {
      // Deliberately one message for every cause. Distinguishing "expired" from
      // "wrong type" from "wrong audience" tells an attacker which of their
      // guesses was closest.
      throw new UnauthorizedException("Invalid or expired access token");
    }
    // A token that verifies but names no role is not "role-free", it is
    // malformed. RolesGuard fails closed on this too; refusing here means a
    // route that somehow escapes RolesGuard still cannot see it as authorized.
    if (!claims.sub || !claims.orgId || !claims.role) {
      throw new UnauthorizedException("Invalid or expired access token");
    }
    req.auth = {
      sub: claims.sub,
      orgId: claims.orgId,
      role: claims.role,
      sv: typeof claims.sv === "number" ? claims.sv : 0,
    };
    return true;
  }
}
