import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  brandKitSchema,
  generateImageSchema,
  generateVideoSchema,
  uploadMediaSchema,
  type BrandKitInput,
  type GenerateImageInput,
  type GenerateVideoInput,
  type UploadMediaInput,
} from "@godeye/shared";
import { z } from "zod";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { ZodPipe } from "../common/zod.pipe";
import { MediaService } from "./media.service";

const attachSchema = z.object({ contentItemId: z.string().min(1) });
const logoSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().regex(/^image\/(png|jpe?g)$/),
  dataBase64: z.string().min(1).max(8_000_000),
});

// base64 inflates by about a third, so this caps the decoded track near 15 MB,
// which is generous for a background bed under a 30 to 90 second video.
const brandMusicSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().regex(/^audio\/(mpeg|mp3|wav|x-wav|mp4|aac|ogg)$/),
  dataBase64: z.string().min(1).max(21_000_000),
});

@ApiTags("media")
@Controller("media")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post("generate-image")
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: "Queue AI image generation (Image Agent in the Python engine)" })
  generate(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(generateImageSchema)) body: GenerateImageInput,
  ) {
    return this.media.generateImage(auth.orgId, auth.sub, body);
  }

  @Post("generate-video")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: "Queue AI short-video generation (Video Agent in the Python engine)" })
  generateVideo(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(generateVideoSchema)) body: GenerateVideoInput,
  ) {
    return this.media.generateVideo(auth.orgId, auth.sub, body);
  }

  @Post("upload")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Upload your own photo and attach it to a content item" })
  upload(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(uploadMediaSchema)) body: UploadMediaInput,
  ) {
    return this.media.uploadPhoto(auth.orgId, auth.sub, body);
  }

  @Get()
  list(@CurrentAuth() auth: AccessTokenPayload, @Query("contentItemId") contentItemId?: string) {
    return this.media.list(auth.orgId, contentItemId);
  }

  @Post(":id/attach")
  attach(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("id") id: string,
    @Body(new ZodPipe(attachSchema)) body: z.infer<typeof attachSchema>,
  ) {
    return this.media.attach(auth.orgId, id, body.contentItemId);
  }

  @Delete(":id")
  remove(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.media.remove(auth.orgId, id);
  }

  // ---------- Brand kit ----------

  @Get("brand-kit")
  getBrandKit(@CurrentAuth() auth: AccessTokenPayload) {
    return this.media.getBrandKit(auth.orgId);
  }

  @Put("brand-kit")
  upsertBrandKit(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(brandKitSchema)) body: BrandKitInput,
  ) {
    return this.media.upsertBrandKit(auth.orgId, auth.sub, body);
  }

  @Post("brand-kit/logo")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Upload a brand logo (base64 PNG/JPEG, max ~5 MB)" })
  uploadLogo(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(logoSchema)) body: z.infer<typeof logoSchema>,
  ) {
    return this.media.uploadLogo(auth.orgId, auth.sub, body);
  }

  @Post("brand-kit/music")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: "Upload the background track mixed under generated video (base64 audio)",
  })
  uploadBrandMusic(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(brandMusicSchema)) body: z.infer<typeof brandMusicSchema>,
  ) {
    return this.media.uploadBrandMusic(auth.orgId, auth.sub, body);
  }

  @Delete("brand-kit/music")
  @ApiOperation({ summary: "Remove the background track" })
  removeBrandMusic(@CurrentAuth() auth: AccessTokenPayload) {
    return this.media.removeBrandMusic(auth.orgId, auth.sub);
  }
}
