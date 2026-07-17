import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MIN_ROLE_KEY, roleAtLeast, RolesGuard, type OrgRole } from "./roles.guard";

function contextWithRole(role: OrgRole | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ auth: role ? { sub: "u1", orgId: "o1", role } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function guardRequiring(required: OrgRole | undefined): RolesGuard {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => (key === MIN_ROLE_KEY ? required : undefined)),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

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
  it("passes routes without a @MinRole requirement", () => {
    expect(guardRequiring(undefined).canActivate(contextWithRole("VIEWER"))).toBe(true);
  });

  it("allows equal or higher roles", () => {
    expect(guardRequiring("EDITOR").canActivate(contextWithRole("EDITOR"))).toBe(true);
    expect(guardRequiring("EDITOR").canActivate(contextWithRole("OWNER"))).toBe(true);
  });

  it("rejects lower roles", () => {
    expect(() => guardRequiring("ADMIN").canActivate(contextWithRole("EDITOR"))).toThrow(
      ForbiddenException,
    );
  });

  it("rejects when auth is missing entirely", () => {
    expect(() => guardRequiring("VIEWER").canActivate(contextWithRole(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
