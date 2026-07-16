import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { env } from "./env";

export interface AccessTokenPayload {
  sub: string; // user id
  orgId: string;
  role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
}

export interface AuthenticatedRequest extends Request {
  auth: AccessTokenPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing access token");
    }
    try {
      req.auth = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), {
        secret: env.jwtAccessSecret(),
      });
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }
}
