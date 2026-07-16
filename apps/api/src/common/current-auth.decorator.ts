import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { AccessTokenPayload, AuthenticatedRequest } from "./jwt-auth.guard";

/** Injects the verified JWT payload ({ sub, orgId, role }) into a handler param. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload => {
    return ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  },
);
