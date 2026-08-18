import { CallHandler, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { of } from "rxjs";
import { TrialLockInterceptor } from "./trial-lock.interceptor";
import { WorkspaceAccessService } from "./workspace-access.service";

function contextFor(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of("handled") };

describe("TrialLockInterceptor", () => {
  let access: { state: jest.Mock };
  let interceptor: TrialLockInterceptor;

  const locked = { status: "LOCKED", locked: true, trialEndsAt: null, planCode: "PRO" };
  const trialing = {
    status: "TRIALING",
    locked: false,
    trialEndsAt: "2026-08-18T00:00:00.000Z",
    planCode: "PRO",
  };

  beforeEach(() => {
    access = { state: jest.fn().mockResolvedValue(locked) };
    interceptor = new TrialLockInterceptor(access as unknown as WorkspaceAccessService);
  });

  it("refuses a write from a locked workspace", async () => {
    const ctx = contextFor({ method: "POST", path: "/content", auth: { orgId: "org1" } });
    await expect(interceptor.intercept(ctx, next)).rejects.toThrow(ForbiddenException);
  });

  it("names the reason, so the app can tell the customer what to do", async () => {
    const ctx = contextFor({ method: "POST", path: "/content", auth: { orgId: "org1" } });
    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      response: { code: "WORKSPACE_LOCKED" },
    });
  });

  it.each(["GET", "HEAD", "OPTIONS"])("still allows %s, read-only, not shut", async (method) => {
    const ctx = contextFor({ method, path: "/content", auth: { orgId: "org1" } });
    await expect(interceptor.intercept(ctx, next)).resolves.toBeDefined();
    expect(access.state).not.toHaveBeenCalled();
  });

  it.each([
    ["/billing/checkout", "paying is how the lock is lifted"],
    ["/auth/logout", "a payment problem must not trap somebody in their account"],
    ["/auth/refresh", "the session has to keep working"],
    ["/webhooks/paystack", "this is how the payment arrives"],
  ])("keeps %s open (%s)", async (path) => {
    const ctx = contextFor({ method: "POST", path, auth: { orgId: "org1" } });
    await expect(interceptor.intercept(ctx, next)).resolves.toBeDefined();
  });

  it("does not open a route that merely starts with an allowed word", async () => {
    const ctx = contextFor({ method: "POST", path: "/authorship", auth: { orgId: "org1" } });
    await expect(interceptor.intercept(ctx, next)).rejects.toThrow(ForbiddenException);
  });

  it("allows writes while the trial is still running", async () => {
    access.state.mockResolvedValue(trialing);
    const ctx = contextFor({ method: "POST", path: "/content", auth: { orgId: "org1" } });
    await expect(interceptor.intercept(ctx, next)).resolves.toBeDefined();
  });

  it("leaves unauthenticated requests to the route's own guard", async () => {
    const ctx = contextFor({ method: "POST", path: "/content" });
    await expect(interceptor.intercept(ctx, next)).resolves.toBeDefined();
    expect(access.state).not.toHaveBeenCalled();
  });
});
