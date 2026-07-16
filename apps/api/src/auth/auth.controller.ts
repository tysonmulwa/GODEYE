import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { loginSchema, registerSchema } from "@godeye/shared";
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
    res.clearCookie(REFRESH_COOKIE, { path: "/auth" });
    return { ok: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@CurrentAuth() auth: AccessTokenPayload) {
    return this.auth.me(auth);
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
      httpOnly: true,
      secure: env.nodeEnv === "production",
      sameSite: "lax",
      path: "/auth",
      maxAge: 30 * 24 * 3600 * 1000,
    });
    return rest;
  }
}
