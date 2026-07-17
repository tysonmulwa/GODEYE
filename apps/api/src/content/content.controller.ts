import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  generateContentSchema,
  reviewContentSchema,
  type GenerateContentInput,
  type ReviewContentInput,
} from "@godeye/shared";
import { z } from "zod";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { MinRole, RolesGuard } from "../common/roles.guard";
import { ZodPipe } from "../common/zod.pipe";
import { ContentService } from "./content.service";

const manualContentSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(50_000),
  hashtags: z.array(z.string().max(100)).max(50).optional(),
});

// Review statuses move through the dedicated submit/approve/reject endpoints;
// SCHEDULED/PUBLISHED/FAILED are set by the system.
const updateContentSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(50_000).optional(),
  hashtags: z.array(z.string().max(100)).max(50).optional(),
  status: z.enum(["DRAFT", "ARCHIVED"]).optional(),
  variants: z.record(z.object({ body: z.string(), hashtags: z.array(z.string()) })).optional(),
  evergreen: z.boolean().optional(),
});

@ApiTags("content")
@Controller("content")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Post("generate")
  @MinRole("EDITOR")
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
  @MinRole("EDITOR")
  create(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(manualContentSchema)) body: z.infer<typeof manualContentSchema>,
  ) {
    return this.content.createManual(auth.orgId, auth.sub, body);
  }

  @Patch(":id")
  @MinRole("EDITOR")
  update(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(updateContentSchema)) body: z.infer<typeof updateContentSchema>,
  ) {
    return this.content.update(auth.orgId, id, body);
  }

  // ---------- Approval workflow ----------

  @Post(":id/submit")
  @MinRole("EDITOR")
  @ApiOperation({ summary: "Submit a draft for review (DRAFT → PENDING_APPROVAL)" })
  submit(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.content.submitForReview(auth.orgId, auth.sub, id);
  }

  @Post(":id/approve")
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Approve content (PENDING_APPROVAL → APPROVED)" })
  approve(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.content.approve(auth.orgId, auth.sub, id);
  }

  @Post(":id/reject")
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Reject content back to draft, with an optional note" })
  reject(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(reviewContentSchema)) body: ReviewContentInput,
  ) {
    return this.content.reject(auth.orgId, auth.sub, id, body.note);
  }
}
