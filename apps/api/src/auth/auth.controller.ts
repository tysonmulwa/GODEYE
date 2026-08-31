import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  acceptInvitationSchema,
  changeEmailSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  switchOrgSchema,
  updateProfileSchema,
  type ChangeEmailInput,
  type ChangePasswordInput,
  type UpdateProfileInput,
} from "@godeye/shared";
import * as argon2 from "argon2";
import type { Request, Response } from "express";
import { z } from "zod";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { env } from "../common/env";
import { PasswordResetService } from "./password-reset.service";
import { ZodPipe } from "../common/zod.pipe";
import { AuthService, SessionResult } from "./auth.service";
import { Public } from "../common/public.decorator";
import { MinRole } from "../common/roles.guard";

const REFRESH_COOKIE = "godeye_refresh";
const loginWithMfaSchema = loginSchema.extend({ mfaCode: z.string().optional() });
const mfaCodeSchema = z.object({ code: z.string().min(6).max(8) });
// Disabling asks for both factors it is about to stop requiring: a session
// alone should not be enough to remove the protection guarding the account.
const mfaDisableSchema = z.object({
  password: z.string().min(1),
  // 6 for TOTP, up to 11 for a recovery code written XXXXX-XXXXX.
  code: z.string().min(6).max(11),
});

/**
 * Reissuing recovery codes needs the password, not just a session.
 *
 * Each code completes a sign-in on its own, so this endpoint hands out
 * credentials. A borrowed unlocked laptop must not be enough to mint a fresh
 * set and walk off with it.
 */
const backupCodesSchema = z.object({ password: z.string().min(1) });

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
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Post("register")
  @Public()
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
  @Public()
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

  /**
   * Start a password reset.
   *
   * Always 202, always the same body, whether or not the address is
   * registered. Anything else is a membership oracle: an attacker with a list
   * of addresses learns which have GODEYE accounts, which is worth money on its
   * own and is a far better starting point for credential stuffing.
   *
   * A delivery failure is logged rather than returned, for the same reason.
   */
  @Post("forgot-password")
  @Public()
  @HttpCode(202)
  // Tighter than login: this one sends mail, so abuse costs money and puts the
  // sending domain's reputation at risk, not just CPU.
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @ApiOperation({ summary: "Email a password reset link, if the address is registered" })
  async forgotPassword(
    @Body(new ZodPipe(forgotPasswordSchema)) body: z.infer<typeof forgotPasswordSchema>,
    @Req() req: Request,
  ) {
    await this.passwordReset.request(body.email, this.ctx(req).ip);
    return { message: "If that address has an account, a reset link is on its way." };
  }

  /**
   * Finish a password reset.
   *
   * One generic failure for every rejection. Distinguishing "expired" from
   * "already used" from "never existed" tells an attacker which guesses were
   * close enough to be worth refining.
   */
  @Post("reset-password")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @ApiOperation({ summary: "Set a new password using a reset token" })
  async resetPassword(
    @Body(new ZodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ) {
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    const userId = await this.passwordReset.consume(body.token, passwordHash);
    if (!userId) {
      throw new BadRequestException("That reset link is no longer valid. Request a new one.");
    }
    return { message: "Your password has been changed. Sign in with it." };
  }

  @Post("refresh")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Rotate the refresh token and get a new access token" })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? "";
    const session = await this.auth.refresh(token, this.ctx(req));
    return this.respond(session, res);
  }

  @Post("logout")
  @Public()
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
    return { ok: true };
  }

  @Get("me")
  @MinRole("VIEWER")
  @ApiBearerAuth()
  me(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.me(auth);
  }

  @Patch("me")
  @MinRole("VIEWER")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change your own name or avatar" })
  updateProfile(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(updateProfileSchema)) body: UpdateProfileInput,
  ) {
    return this.auth.updateProfile(auth, body);
  }

  @Post("change-password")
  @MinRole("VIEWER")
  @HttpCode(200)
  @ApiBearerAuth()
  // Guessing the current password is the attack this endpoint invites.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Change your password and end your other sessions" })
  changePassword(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() req: Request,
  ) {
    // Hand the current session's token through so it is the one kept alive.
    return this.auth.changePassword(
      auth,
      body,
      req.cookies?.[REFRESH_COOKIE] as string | undefined,
    );
  }

  @Post("change-email")
  @MinRole("VIEWER")
  @HttpCode(200)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Change the address your account signs in with" })
  changeEmail(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(changeEmailSchema)) body: ChangeEmailInput,
  ) {
    return this.auth.changeEmail(auth, body);
  }

  @Get("invitations/:token")
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Preview an invite link (public)" })
  previewInvitation(@Param("token") token: string) {
    return this.auth.previewInvitation(token);
  }

  @Post("accept-invitation")
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Accept an invite, creates the account if the email is new" })
  async acceptInvitation(
    @Body(new ZodPipe(acceptInvitationSchema)) body: z.infer<typeof acceptInvitationSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.acceptInvitation(body, this.ctx(req));
    return this.respond(session, res);
  }

  @Get("orgs")
  @MinRole("VIEWER")
  @ApiBearerAuth()
  @ApiOperation({ summary: "List every organization the caller belongs to" })
  listOrgs(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.listOrgs(auth.sub);
  }

  @Post("switch-org")
  @MinRole("VIEWER")
  @HttpCode(200)
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
  @MinRole("VIEWER")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Begin TOTP MFA setup, returns otpauth:// URL for authenticator apps" })
  setupMfa(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.setupMfa(auth.sub);
  }

  @Post("mfa/enable")
  @MinRole("VIEWER")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Turn MFA on. Returns the recovery codes, which are shown once and never again",
  })
  async enableMfa(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(mfaCodeSchema)) body: z.infer<typeof mfaCodeSchema>,
  ) {
    // The codes come back in this response and in no other. They are stored as
    // argon2id hashes, so there is no endpoint that can show them again -- the
    // client has to put them in front of the user now.
    const { backupCodes } = await this.auth.enableMfa(auth.sub, body.code);
    return { ok: true, backupCodes };
  }

  @Post("mfa/backup-codes")
  @MinRole("VIEWER")
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Issue a new set of recovery codes, invalidating the old set" })
  async regenerateBackupCodes(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(backupCodesSchema)) body: z.infer<typeof backupCodesSchema>,
  ) {
    return this.auth.regenerateBackupCodes(auth.sub, body.password);
  }

  @Post("mfa/disable")
  @MinRole("VIEWER")
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: "Turn MFA off, needs the account password and a current code",
  })
  async disableMfa(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(mfaDisableSchema)) body: z.infer<typeof mfaDisableSchema>,
  ) {
    await this.auth.disableMfa(auth.sub, body.password, body.code);
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
