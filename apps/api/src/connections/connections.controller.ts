import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  discordConnectSchema,
  redditConnectSchema,
  telegramConnectSchema,
  xConnectSchema,
  type DiscordConnectInput,
  type RedditConnectInput,
  type TelegramConnectInput,
  type XConnectInput,
} from "@godeye/shared";
import type { Response } from "express";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { env } from "../common/env";
import { ZodPipe } from "../common/zod.pipe";
import { ConnectionsService } from "./connections.service";

@ApiTags("connections")
@Controller("connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  list(@CurrentAuth() auth: AccessTokenPayload) {
    return this.connections.list(auth.orgId);
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  remove(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.connections.remove(auth.orgId, id, auth.sub);
  }

  @Post("telegram")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Connect a Telegram bot + channel" })
  connectTelegram(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(telegramConnectSchema)) body: TelegramConnectInput,
  ) {
    return this.connections.connectTelegram(auth.orgId, auth.sub, body);
  }

  @Post("discord")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Connect a Discord bot + channel" })
  connectDiscord(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(discordConnectSchema)) body: DiscordConnectInput,
  ) {
    return this.connections.connectDiscord(auth.orgId, auth.sub, body);
  }

  @Post("reddit")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Connect a Reddit account (script app) + default subreddit" })
  connectReddit(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(redditConnectSchema)) body: RedditConnectInput,
  ) {
    return this.connections.connectReddit(auth.orgId, auth.sub, body);
  }

  @Post("x")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Connect an X (Twitter) account via developer-app keys" })
  connectX(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(xConnectSchema)) body: XConnectInput,
  ) {
    return this.connections.connectX(auth.orgId, auth.sub, body);
  }

  @Get("linkedin/authorize")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the LinkedIn OAuth dialog URL" })
  linkedinAuthorize(@CurrentAuth() auth: AccessTokenPayload) {
    return this.connections.linkedinAuthorize(auth.orgId, auth.sub);
  }

  @Get("linkedin/callback")
  @ApiOperation({ summary: "OAuth redirect target for LinkedIn — do not call directly" })
  async linkedinCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const base = `${env.webUrl}/connections`;
    if (errorDescription || !code || !state) {
      return res.redirect(
        `${base}?error=${encodeURIComponent(errorDescription ?? "LinkedIn authorization failed")}`,
      );
    }
    try {
      await this.connections.linkedinCallback(code, state);
      return res.redirect(`${base}?connected=linkedin&count=1`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "LinkedIn connection failed";
      return res.redirect(`${base}?error=${encodeURIComponent(message)}`);
    }
  }

  @Get("meta/authorize")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the Facebook OAuth dialog URL (Facebook Pages + Instagram)" })
  metaAuthorize(@CurrentAuth() auth: AccessTokenPayload) {
    return this.connections.metaAuthorize(auth.orgId, auth.sub);
  }

  @Get("meta/callback")
  @ApiOperation({ summary: "OAuth redirect target for Meta — do not call directly" })
  async metaCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const base = `${env.webUrl}/connections`;
    if (errorDescription || !code || !state) {
      return res.redirect(`${base}?error=${encodeURIComponent(errorDescription ?? "Meta authorization failed")}`);
    }
    try {
      const result = await this.connections.metaCallback(code, state);
      return res.redirect(`${base}?connected=meta&count=${result.connected}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Meta connection failed";
      return res.redirect(`${base}?error=${encodeURIComponent(message)}`);
    }
  }
}
