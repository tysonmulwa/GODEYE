import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  acceptInvitationSchema,
  loginSchema,
  registerSchema,
  switchOrgSchema,
} from "@godeye/shared";
import type { Request, Response } from "express";
import { z } from "zod";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { env } from "../common/env";
import { ZodPipe } from "../common/zod.pipe";
import { AuthService, SessionResult } from "./auth.service";

const REFRESH_COOKIE = "godeye_refresh";
const loginWithMfaSchema = loginSchema.extend({ mfaCode: z.string().optional() });
const mfaCodeSchema = z.object({ code: z.string().min(6).max(8) });

/**
 * SameSite is decided by whether WEB_URL and API_URL share a registrable
 * domain, not by NODE_ENV.
 *
 * Split across sites (vercel.app + railway.app) the cookie must be
 * SameSite=None, and browsers that block third-party cookies then drop it,
 * losing the session on every reload. Served from one domain
 * (godeyeautomation.com + api.godeyeautomation.com) it is same-site, so Lax
 * works and additionally protects against CSRF.
 *
 * Secure still follows NODE_ENV: required over https, and it would drop the
 * cookie on plain-http localhost.
 */
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: env.nodeEnv === "production",
  sameSite: env.isCrossSite ? ("none" as const) : ("lax" as const),
  path: "/auth",
};

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Create an account and organization" })
  async register(
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.register(body, this.ctx(req));
    return this.respond(session, res);
  }

  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Log in (include mfaCode if MFA is enabled)" })
  async login(
    @Body(new ZodPipe(loginWithMfaSchema)) body: z.infer<typeof loginWithMfaSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.login(body, this.ctx(req));
    return this.respond(session, res);
  }

  @Post("refresh")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Rotate the refresh token and get a new access token" })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? "";
    const session = await this.auth.refresh(token, this.ctx(req));
    return this.respond(session, res);
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
    return { ok: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.me(auth);
  }

  @Get("invitations/:token")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Preview an invite link (public)" })
  previewInvitation(@Param("token") token: string) {
    return this.auth.previewInvitation(token);
  }

  @Post("accept-invitation")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Accept an invite — creates the account if the email is new" })
  async acceptInvitation(
    @Body(new ZodPipe(acceptInvitationSchema)) body: z.infer<typeof acceptInvitationSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.acceptInvitation(body, this.ctx(req));
    return this.respond(session, res);
  }

  @Get("orgs")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List every organization the caller belongs to" })
  listOrgs(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.listOrgs(auth.sub);
  }

  @Post("switch-org")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a session scoped to another org you belong to" })
  async switchOrg(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(switchOrgSchema)) body: z.infer<typeof switchOrgSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.switchOrg(auth.sub, body.orgId, this.ctx(req));
    return this.respond(session, res);
  }

  @Post("mfa/setup")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Begin TOTP MFA setup — returns otpauth:// URL for authenticator apps" })
  setupMfa(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.setupMfa(auth.sub);
  }

  @Post("mfa/enable")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async enableMfa(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>,
  ) {
    await this.auth.enableMfa(auth.sub, body.code);
    return { ok: true };
  }

  private ctx(req: Request) {
    return { ip: req.ip, userAgent: req.headers["user-agent"] };
  }

  private respond(session: SessionResult, res: Response) {
    const { refreshToken, ...rest } = session;
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...REFRESH_COOKIE_OPTS,
      maxAge: 30 * 24 * 3600 * 1000,
    });
    return rest;
  }
}
