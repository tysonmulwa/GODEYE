import { SetMetadata } from "@nestjs/common";

export const PUBLIC_KEY = "isPublic";

/**
 * Marks a route as reachable without a session.
 *
 * Authorization is default-deny: a route with neither `@Public()` nor
 * `@MinRole()` is refused by RolesGuard and refuses to boot at all (see
 * RouteAuditService). So this decorator is not a convenience — it is the
 * explicit, reviewable statement that a route is meant to be open.
 *
 * Everything here is either pre-session (login, register, invite acceptance),
 * a provider's redirect target (OAuth callbacks, webhooks — authenticated by
 * their own signature or single-use state), or infrastructure (health).
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
