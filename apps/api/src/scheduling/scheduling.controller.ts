import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  postingPlanSchema,
  schedulePostSchema,
  updatePostingPlanSchema,
  type PostingPlanInput,
  type SchedulePostInput,
  type UpdatePostingPlanInput,
} from "@godeye/shared";
import { z } from "zod";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { MinRole, RolesGuard } from "../common/roles.guard";
import { ZodPipe } from "../common/zod.pipe";
import { SchedulingService } from "./scheduling.service";

const editScheduledPostSchema = z
  .object({
    body: z.string().min(1).max(50_000).optional(),
    scheduledAt: z.string().datetime().optional(),
  })
  .refine((v) => v.body !== undefined || v.scheduledAt !== undefined, {
    message: "Provide a new body, a new time, or both",
  });

@ApiTags("scheduling")
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post("schedule")
  @MinRole("EDITOR")
  @ApiOperation({ summary: "Schedule a content item to one or more connections" })
  schedule(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(schedulePostSchema)) body: SchedulePostInput,
  ) {
    return this.scheduling.schedule(auth.orgId, auth.sub, body);
  }

  @Get("schedule")
  list(
    @CurrentAuth() auth: AccessTokenPayload,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("includeCancelled") includeCancelled?: string,
  ) {
    return this.scheduling.list(auth.orgId, from, to, includeCancelled === "1");
  }

  @Post("schedule/:id/cancel")
  @MinRole("EDITOR")
  cancel(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.scheduling.cancel(auth.orgId, id, auth.sub);
  }

  @Patch("schedule/:id")
  @MinRole("EDITOR")
  @ApiOperation({ summary: "Edit a pending or failed post's text and/or time, and re-queue it" })
  edit(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(editScheduledPostSchema)) body: z.infer<typeof editScheduledPostSchema>,
  ) {
    return this.scheduling.editPending(auth.orgId, id, auth.sub, body);
  }

  @Post("schedule/:id/retry")
  @MinRole("EDITOR")
  retry(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.scheduling.retry(auth.orgId, id, auth.sub);
  }

  @Post("posting-plans")
  @MinRole("EDITOR")
  createPlan(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(postingPlanSchema)) body: PostingPlanInput,
  ) {
    return this.scheduling.createPlan(auth.orgId, auth.sub, body);
  }

  @Get("posting-plans")
  listPlans(@CurrentAuth() auth: AccessTokenPayload) {
    return this.scheduling.listPlans(auth.orgId);
  }

  @Patch("posting-plans/:id")
  @MinRole("EDITOR")
  @ApiOperation({ summary: "Update a posting plan (toggle active, autopilot, cadence...)" })
  updatePlan(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(updatePostingPlanSchema)) body: UpdatePostingPlanInput,
  ) {
    return this.scheduling.updatePlan(auth.orgId, id, auth.sub, body);
  }

  @Get("best-times")
  @ApiOperation({ summary: "Engagement-driven best posting times for a platform" })
  bestTimes(
    @CurrentAuth() auth: AccessTokenPayload,
    @Query("platform") platform: string,
    @Query("timezone") timezone = "UTC",
  ) {
    return this.scheduling.bestTimes(auth.orgId, platform, timezone);
  }

  @Get("content/:id/ab-report")
  @ApiOperation({ summary: "A/B test engagement report for a content item" })
  abReport(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.scheduling.abReport(auth.orgId, id);
  }
}
