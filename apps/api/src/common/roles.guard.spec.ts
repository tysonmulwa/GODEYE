/**
 * S-1 — the guard is now global, and default-deny.
 *
 * The previous version of this file asserted that "routes without a @MinRole
 * requirement" pass. That assertion was the defect in test form: it is exactly
 * why connections, media, seo, products and business-profile were writable by a
 * VIEWER, and why adding @MinRole to any of them would have been a silent
 * no-op. It has been replaced, not deleted — the route it described is now
 * refused, and refuses the whole boot as well (route-audit.service.ts).
 */
process.env.JWT_ACCESS_SECRET = "roles-guard-spec-access-secret-9f2c1a";
process.env.JWT_REFRESH_SECRET = "roles-guard-spec-refresh-secret-4b8e2d";
process.env.OAUTH_STATE_SECRET = "roles-guard-spec-state-secret-7c3a9e11";

import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { MIN_ROLE_KEY, roleAtLeast, RolesGuard, type OrgRole } from "./roles.guard";
import type { MembershipService } from "./membership.service";
import { PUBLIC_KEY } from "./public.decorator";
import { signToken } from "./tokens";

const jwt = new JwtService({});

function context(token: string | undefined): ExecutionContext {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} } as {
    headers: Record<string, string>;
    auth?: unknown;
  };
  return {
    getType: () => "http",
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/**
 * `live` is what the database says right now. `undefined` means "still an
 * OWNER at version 0"; `null` means the membership is gone.
 */
function guard(meta: {
  required?: OrgRole;
  isPublic?: boolean;
  live?: { role: OrgRole; sessionVersion: number } | null;
}): RolesGuard {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === MIN_ROLE_KEY ? meta.required : key === PUBLIC_KEY ? meta.isPublic : undefined,
    ),
  } as unknown as Reflector;
  const memberships = {
    current: jest.fn().mockResolvedValue(
      meta.live === undefined ? { role: "OWNER" as OrgRole, sessionVersion: 0 } : meta.live,
    ),
  } as unknown as MembershipService;
  return new RolesGuard(reflector, jwt, memberships);
}

const tokenFor = (role: OrgRole, sv = 0) =>
  signToken(jwt, "access", { sub: "u1", orgId: "o1", role, sv }, "5m");

describe("roleAtLeast", () => {
  it("orders OWNER > ADMIN > EDITOR > VIEWER", () => {
    expect(roleAtLeast("OWNER", "ADMIN")).toBe(true);
    expect(roleAtLeast("ADMIN", "ADMIN")).toBe(true);
    expect(roleAtLeast("EDITOR", "ADMIN")).toBe(false);
    expect(roleAtLeast("VIEWER", "EDITOR")).toBe(false);
    expect(roleAtLeast("EDITOR", "EDITOR")).toBe(true);
  });
});

describe("RolesGuard", () => {
  it("DENIES a route that declares no access level", async () => {
    await expect(guard({ required: undefined }).canActivate(context(await tokenFor("OWNER")))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("says why, so the missing annotation is the obvious fix", async () => {
    await expect(
      guard({}).canActivate(context(await tokenFor("OWNER"))),
    ).rejects.toThrow(/@Public\(\) or @MinRole\(\)/);
  });

  it("allows equal or higher roles", async () => {
    const editor = { role: "EDITOR" as OrgRole, sessionVersion: 0 };
    await expect(
      guard({ required: "EDITOR", live: editor }).canActivate(context(await tokenFor("EDITOR"))),
    ).resolves.toBe(true);
    await expect(
      guard({ required: "EDITOR" }).canActivate(context(await tokenFor("OWNER"))),
    ).resolves.toBe(true);
  });

  it("rejects lower roles", async () => {
    await expect(
      guard({
        required: "ADMIN",
        live: { role: "EDITOR", sessionVersion: 0 },
      }).canActivate(context(await tokenFor("EDITOR"))),
    ).rejects.toThrow(ForbiddenException);
  });

  // ---------- S-10: the database decides, not the token ----------

  it("refuses a token that still claims ADMIN once the row says VIEWER", async () => {
    // The demotion has landed. The token has not expired. Before this, the
    // holder kept ADMIN for the rest of its 15 minutes.
    await expect(
      guard({
        required: "ADMIN",
        live: { role: "VIEWER", sessionVersion: 0 },
      }).canActivate(context(await tokenFor("ADMIN"))),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses a token whose membership has been removed", async () => {
    await expect(
      guard({ required: "VIEWER", live: null }).canActivate(context(await tokenFor("OWNER"))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("refuses a token minted before the session version was bumped", async () => {
    // A password change, an MFA change or "sign out everywhere".
    await expect(
      guard({
        required: "VIEWER",
        live: { role: "OWNER", sessionVersion: 3 },
      }).canActivate(context(await tokenFor("OWNER", 2))),
    ).rejects.toThrow(/session has ended/i);
  });

  it("promotes as well as demotes — the live role is the one the handler sees", async () => {
    // A token minted as VIEWER, whose holder has since been made ADMIN, must
    // work. Following the database means following it in both directions.
    await expect(
      guard({
        required: "ADMIN",
        live: { role: "ADMIN", sessionVersion: 0 },
      }).canActivate(context(await tokenFor("VIEWER"))),
    ).resolves.toBe(true);
  });

  it("rejects an unauthenticated caller before it looks at roles", async () => {
    await expect(guard({ required: "VIEWER" }).canActivate(context(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("lets a @Public() route through without a token", async () => {
    await expect(guard({ isPublic: true }).canActivate(context(undefined))).resolves.toBe(true);
  });

  it("refuses an OAuth state token on an authenticated route (C-1)", async () => {
    const state = await signToken(jwt, "oauth_state", { orgId: "o1", sub: "u1" }, "10m");
    await expect(guard({ required: "VIEWER" }).canActivate(context(state))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("does not judge non-HTTP contexts", async () => {
    const ws = { getType: () => "ws" } as unknown as ExecutionContext;
    await expect(guard({ required: "OWNER" }).canActivate(ws)).resolves.toBe(true);
  });
});
