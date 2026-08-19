import type { JwtService, JwtSignOptions, JwtVerifyOptions } from "@nestjs/jwt";
import { env } from "./env";

/**
 * Every JWT this API mints carries a `typ`, and every verifier demands the one
 * it expects.
 *
 * Finding C-1 was the absence of this. OAuth `state` was a JWT signed with
 * JWT_ACCESS_SECRET, and JwtAuthGuard checked signature and expiry only — so a
 * value *designed* to travel through Meta, TikTok, LinkedIn and Reddit, and to
 * land in their logs, in browser history and in Referer headers, was a bearer
 * session credential. Replaying one against POST /auth/switch-org returned a
 * fresh 15-minute access token and a 30-day refresh cookie: a leaked query
 * parameter became a permanent session.
 *
 * Two independent defences, because either alone can be undone by a future
 * change nobody reviews closely:
 *   1. different key material per purpose (env.oauthStateSecret)
 *   2. a `typ` claim the verifier insists on
 *
 * RFC 8725 §3.1 (explicit typing), §3.2 (algorithm allow-list), §3.8 (key
 * separation), §3.11/§3.12 (iss/aud validation).
 */
export const TOKEN_TYPES = ["access", "refresh", "oauth_state", "invite"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

/** HS256 only. Never trust the `alg` in the header — that is how `alg: none`
 *  and algorithm-confusion attacks get in (RFC 8725 §3.2). */
const ALGORITHMS = ["HS256"] as const;

export interface TypedClaims {
  typ: TokenType;
  iss: string;
  aud: string;
}

function secretFor(typ: TokenType): string {
  switch (typ) {
    case "access":
      return env.jwtAccessSecret();
    case "refresh":
      return env.jwtRefreshSecret();
    case "oauth_state":
      return env.oauthStateSecret();
    case "invite":
      // Invites are single-use database rows; the JWT path exists only for
      // links that carry no server-side state. Same key class as OAuth state:
      // it travels through email, so it is never a session.
      return env.oauthStateSecret();
  }
}

export function signOptions(
  typ: TokenType,
  expiresIn: JwtSignOptions["expiresIn"],
): JwtSignOptions {
  return {
    secret: secretFor(typ),
    algorithm: "HS256",
    expiresIn,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  };
}

export function verifyOptions(typ: TokenType): JwtVerifyOptions {
  return {
    secret: secretFor(typ),
    algorithms: [...ALGORITHMS],
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  };
}

/** Sign a token of exactly one type. `typ` is a claim, not a convention. */
export async function signToken<T extends object>(
  jwt: JwtService,
  typ: TokenType,
  payload: T,
  expiresIn: JwtSignOptions["expiresIn"],
): Promise<string> {
  return jwt.signAsync({ ...payload, typ }, signOptions(typ, expiresIn));
}

/**
 * Verify a token and refuse anything that is not exactly the expected type.
 *
 * The `typ` check runs after signature verification and is not optional: a
 * token with no `typ` at all is refused too. Every token this API has ever
 * minted without one is, by construction, one of the tokens C-1 was about.
 */
export async function verifyToken<T extends object>(
  jwt: JwtService,
  typ: TokenType,
  token: string,
): Promise<T & TypedClaims> {
  const claims = await jwt.verifyAsync<T & Partial<TypedClaims>>(token, verifyOptions(typ));
  if (claims.typ !== typ) {
    throw new Error(`Expected a ${typ} token, got ${claims.typ ?? "an untyped token"}`);
  }
  return claims as T & TypedClaims;
}
