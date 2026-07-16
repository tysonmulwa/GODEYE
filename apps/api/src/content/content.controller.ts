import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { generateContentSchema, type GenerateContentInput } from "@godeye/shared";
import { z } from "zod";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { ZodPipe } from "../common/zod.pipe";
import { ContentService } from "./content.service";

const manualContentSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(50_000),
  hashtags: z.array(z.string().max(100)).max(50).optional(),
});

const updateContentSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(50_000).optional(),
  hashtags: z.array(z.string().max(100)).max(50).optional(),
  status: z
    .enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "FAILED", "ARCHIVED"])
    .optional(),
  variants: z.record(z.object({ body: z.string(), hashtags: z.array(z.string()) })).optional(),
  evergreen: z.boolean().optional(),
});

@ApiTags("content")
@Controller("content")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Post("generate")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Queue AI content generation (Content Agent in the Python engine)" })
  generate(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(generateContentSchema)) body: GenerateContentInput,
  ) {
    return this.content.generate(auth.orgId, auth.sub, body);
  }

  @Get("agent-runs/:id")
  @ApiOperation({ summary: "Poll an agent run (fallback to the WebSocket stream)" })
  getAgentRun(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.content.getAgentRun(auth.orgId, id);
  }

  @Get()
  list(@CurrentAuth() auth: AccessTokenPayload, @Query("status") status?: string) {
    return this.content.listContent(auth.orgId, status);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.content.getContent(auth.orgId, id);
  }

  @Post()
  create(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(manualContentSchema)) body: z.infer<typeof manualContentSchema>,
  ) {
    return this.content.createManual(auth.orgId, auth.sub, body);
  }

  @Patch(":id")
  update(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(updateContentSchema)) body: z.infer<typeof updateContentSchema>,
  ) {
    return this.content.update(auth.orgId, id, body);
  }
}
