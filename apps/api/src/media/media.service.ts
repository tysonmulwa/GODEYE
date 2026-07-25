import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  BrandKitInput,
  GenerateImageInput,
  GenerateVideoInput,
  UploadMediaInput,
} from "@godeye/shared";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly audit: AuditService,
  ) {}

  /** Queue AI image generation via the Image Agent in the Python engine. */
  async generateImage(orgId: string, userId: string, input: GenerateImageInput) {
    if (input.contentItemId) {
      const content = await this.prisma.contentItem.findFirst({
        where: { id: input.contentItemId, orgId },
        select: { id: true },
      });
      if (!content) throw new NotFoundException("Content item not found");
    }

    const run = await this.prisma.agentRun.create({
      data: {
        orgId,
        agent: "IMAGE",
        status: "QUEUED",
        input: {
          brief: input.prompt,
          preset: input.preset,
          style: input.style,
          contentItemId: input.contentItemId,
          applyBrand: input.applyBrand,
          requestedBy: userId,
        },
      },
    });

    try {
      const { taskId } = await this.engine.enqueueGenerateImage({
        agentRunId: run.id,
        orgId,
        brief: input.prompt,
        preset: input.preset,
        style: input.style,
        contentItemId: input.contentItemId,
        applyBrand: input.applyBrand,
      });
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { taskId } });
      this.audit.log({
        orgId,
        userId,
        action: "image.generate_requested",
        targetType: "AgentRun",
        targetId: run.id,
      });
      return { agentRunId: run.id, taskId };
    } catch (e) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: e instanceof Error ? e.message : "enqueue failed" },
      });
      throw e;
    }
  }

  /** Queue AI short-video generation via the Video Agent in the Python engine. */
  async generateVideo(orgId: string, userId: string, input: GenerateVideoInput) {
    if (input.contentItemId) {
      const content = await this.prisma.contentItem.findFirst({
        where: { id: input.contentItemId, orgId },
        select: { id: true },
      });
      if (!content) throw new NotFoundException("Content item not found");
    }

    const run = await this.prisma.agentRun.create({
      data: {
        orgId,
        agent: "VIDEO",
        status: "QUEUED",
        input: {
          brief: input.brief,
          preset: input.preset,
          durationSec: input.durationSec,
          voice: input.voice,
          style: input.style,
          includeCaptions: input.includeCaptions,
          contentItemId: input.contentItemId,
          requestedBy: userId,
        },
      },
    });

    try {
      const { taskId } = await this.engine.enqueueGenerateVideo({
        agentRunId: run.id,
        orgId,
        brief: input.brief,
        preset: input.preset,
        durationSec: input.durationSec,
        voice: input.voice,
        style: input.style,
        includeCaptions: input.includeCaptions,
        contentItemId: input.contentItemId,
      });
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { taskId } });
      this.audit.log({
        orgId,
        userId,
        action: "video.generate_requested",
        targetType: "AgentRun",
        targetId: run.id,
      });
      return { agentRunId: run.id, taskId };
    } catch (e) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: e instanceof Error ? e.message : "enqueue failed" },
      });
      throw e;
    }
  }

  /** Upload the user's own photo and attach it to a content item as a MediaAsset. */
  async uploadPhoto(orgId: string, userId: string, input: UploadMediaInput) {
    if (input.contentItemId) {
      const content = await this.prisma.contentItem.findFirst({
        where: { id: input.contentItemId, orgId },
        select: { id: true },
      });
      if (!content) throw new NotFoundException("Content item not found");
    }

    const { storageKey, url, sizeBytes } = await this.engine.storeMedia({
      orgId,
      dataBase64: input.dataBase64,
      contentType: input.contentType,
    });

    const asset = await this.prisma.mediaAsset.create({
      data: {
        orgId,
        contentItemId: input.contentItemId ?? null,
        kind: "IMAGE",
        source: "UPLOADED",
        storageKey,
        url,
        mimeType: input.contentType,
        sizeBytes,
      },
    });
    this.audit.log({
      orgId,
      userId,
      action: "media.uploaded",
      targetType: "MediaAsset",
      targetId: asset.id,
    });
    return this.toDto(asset);
  }

  async list(orgId: string, contentItemId?: string) {
    const rows = await this.prisma.mediaAsset.findMany({
      where: { orgId, ...(contentItemId ? { contentItemId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((m) => this.toDto(m));
  }

  async attach(orgId: string, mediaId: string, contentItemId: string) {
    const [media, content] = await Promise.all([
      this.prisma.mediaAsset.findFirst({ where: { id: mediaId, orgId } }),
      this.prisma.contentItem.findFirst({ where: { id: contentItemId, orgId } }),
    ]);
    if (!media) throw new NotFoundException("Media not found");
    if (!content) throw new NotFoundException("Content not found");
    const updated = await this.prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { contentItemId },
    });
    return this.toDto(updated);
  }

  async remove(orgId: string, mediaId: string) {
    const media = await this.prisma.mediaAsset.findFirst({ where: { id: mediaId, orgId } });
    if (!media) throw new NotFoundException("Media not found");
    await this.prisma.mediaAsset.delete({ where: { id: mediaId } });
    return { ok: true };
  }

  // ---------- Brand kit ----------

  async getBrandKit(orgId: string) {
    const kit = await this.prisma.brandKit.findUnique({ where: { orgId } });
    if (!kit) {
      return {
        primaryColor: "#6366F1",
        secondaryColor: "#0EA5E9",
        logoUrl: null,
        fontFamily: null,
        watermarkEnabled: false,
      };
    }
    return {
      primaryColor: kit.primaryColor,
      secondaryColor: kit.secondaryColor,
      logoUrl: kit.logoUrl,
      fontFamily: kit.fontFamily,
      watermarkEnabled: kit.watermarkEnabled,
    };
  }

  async upsertBrandKit(orgId: string, userId: string, input: BrandKitInput) {
    const data = {
      primaryColor: input.primaryColor,
      secondaryColor: input.secondaryColor,
      fontFamily: input.fontFamily || null,
      watermarkEnabled: input.watermarkEnabled,
    };
    const kit = await this.prisma.brandKit.upsert({
      where: { orgId },
      update: data,
      create: { orgId, ...data },
    });
    this.audit.log({ orgId, userId, action: "brand_kit.saved", targetType: "BrandKit", targetId: kit.id });
    return this.getBrandKit(orgId);
  }

  async uploadLogo(
    orgId: string,
    userId: string,
    file: { filename: string; dataBase64: string; contentType: string },
  ) {
    if (!/^image\/(png|jpe?g)$/.test(file.contentType)) {
      throw new BadRequestException("Logo must be a PNG or JPEG");
    }
    const { storageKey, url } = await this.engine.storeLogo({
      orgId,
      filename: file.filename,
      dataBase64: file.dataBase64,
      contentType: file.contentType,
    });
    await this.prisma.brandKit.upsert({
      where: { orgId },
      update: { logoStorageKey: storageKey, logoUrl: url },
      create: { orgId, logoStorageKey: storageKey, logoUrl: url },
    });
    this.audit.log({ orgId, userId, action: "brand_kit.logo_uploaded" });
    return { logoUrl: url };
  }

  private toDto(m: {
    id: string;
    kind: string;
    source: string;
    url: string | null;
    mimeType: string;
    width: number | null;
    height: number | null;
    prompt: string | null;
    preset: string | null;
    contentItemId: string | null;
    createdAt: Date;
  }) {
    return {
      id: m.id,
      kind: m.kind,
      source: m.source,
      url: m.url,
      mimeType: m.mimeType,
      width: m.width,
      height: m.height,
      prompt: m.prompt,
      preset: m.preset,
      contentItemId: m.contentItemId,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
