import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../common/audit.service";
import { EngineService } from "../engine/engine.service";
import { MediaService } from "./media.service";

function makePrisma() {
  return {
    contentItem: { findFirst: jest.fn() },
    agentRun: {
      create: jest.fn().mockResolvedValue({ id: "run1" }),
      update: jest.fn().mockResolvedValue({}),
    },
    mediaAsset: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    brandKit: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
  };
}

describe("MediaService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let engine: {
    enqueueGenerateImage: jest.Mock;
    enqueueGenerateVideo: jest.Mock;
    storeLogo: jest.Mock;
    storeBrandMusic: jest.Mock;
  };
  let service: MediaService;
  const audit = { log: jest.fn() } as unknown as AuditService;

  beforeEach(() => {
    prisma = makePrisma();
    engine = {
      enqueueGenerateImage: jest.fn().mockResolvedValue({ taskId: "task1" }),
      enqueueGenerateVideo: jest.fn().mockResolvedValue({ taskId: "task2" }),
      storeLogo: jest.fn().mockResolvedValue({ storageKey: "k", url: "http://minio/k.png" }),
      storeBrandMusic: jest
        .fn()
        .mockResolvedValue({ storageKey: "m", url: "http://minio/m.mp3" }),
    };
    service = new MediaService(prisma as never, engine as unknown as EngineService, audit);
  });

  it("queues image generation and records the task id", async () => {
    const result = await service.generateImage("org1", "user1", {
      prompt: "a latte",
      preset: "SQUARE",
      applyBrand: false,
    } as never);
    expect(result).toEqual({ agentRunId: "run1", taskId: "task1" });
    expect(engine.enqueueGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: "run1", orgId: "org1", brief: "a latte" }),
    );
    expect(prisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { taskId: "task1" } }),
    );
  });

  it("rejects generation for a foreign content item", async () => {
    prisma.contentItem.findFirst.mockResolvedValue(null);
    await expect(
      service.generateImage("org1", "user1", {
        prompt: "x",
        preset: "SQUARE",
        contentItemId: "other",
        applyBrand: false,
      } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it("marks the run FAILED if the engine enqueue throws", async () => {
    engine.enqueueGenerateImage.mockRejectedValue(new Error("engine down"));
    await expect(
      service.generateImage("org1", "user1", {
        prompt: "x",
        preset: "SQUARE",
        applyBrand: false,
      } as never),
    ).rejects.toThrow("engine down");
    expect(prisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("queues video generation with the full brief payload", async () => {
    const result = await service.generateVideo("org1", "user1", {
      brief: "3 reasons to try cold brew",
      preset: "VERTICAL",
      durationSec: 30,
      voice: "nova",
      includeCaptions: true,
    } as never);
    expect(result).toEqual({ agentRunId: "run1", taskId: "task2" });
    expect(engine.enqueueGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org1",
        brief: "3 reasons to try cold brew",
        durationSec: 30,
        voice: "nova",
        includeCaptions: true,
      }),
    );
    expect(prisma.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agent: "VIDEO" }) }),
    );
  });

  it("marks the video run FAILED if the engine enqueue throws", async () => {
    engine.enqueueGenerateVideo.mockRejectedValue(new Error("engine down"));
    await expect(
      service.generateVideo("org1", "user1", {
        brief: "x",
        preset: "VERTICAL",
        durationSec: 30,
        voice: "nova",
        includeCaptions: true,
      } as never),
    ).rejects.toThrow("engine down");
    expect(prisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });

  it("returns brand-kit defaults when none saved", async () => {
    prisma.brandKit.findUnique.mockResolvedValue(null);
    const kit = await service.getBrandKit("org1");
    expect(kit).toEqual({
      primaryColor: "#6366F1",
      secondaryColor: "#0EA5E9",
      logoUrl: null,
      fontFamily: null,
      watermarkEnabled: false,
      musicUrl: null,
      musicName: null,
      // A workspace that has never opened Settings still publishes, so these
      // defaults are what most posts actually use.
      slideshowSeconds: 30,
      photosAsReels: true,
    });
  });

  it("stores an uploaded track and remembers its filename", async () => {
    prisma.brandKit.upsert.mockResolvedValue({});
    const result = await service.uploadBrandMusic("org1", "user1", {
      filename: "sunrise-groove.mp3",
      dataBase64: "AAAA",
      contentType: "audio/mpeg",
    });
    expect(result).toEqual({
      musicUrl: "http://minio/m.mp3",
      // The filename is how someone recognises which track is on their videos
      // without downloading it.
      musicName: "sunrise-groove.mp3",
    });
    expect(engine.storeBrandMusic).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1", contentType: "audio/mpeg" }),
    );
  });

  it("refuses a file that is not audio", async () => {
    await expect(
      service.uploadBrandMusic("org1", "user1", {
        filename: "cat.png",
        dataBase64: "AAAA",
        contentType: "image/png",
      }),
    ).rejects.toThrow(/MP3/);
    expect(engine.storeBrandMusic).not.toHaveBeenCalled();
  });

  it("clears every music field on remove", async () => {
    prisma.brandKit.updateMany.mockResolvedValue({ count: 1 });
    await service.removeBrandMusic("org1", "user1");
    expect(prisma.brandKit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { musicStorageKey: null, musicUrl: null, musicName: null },
      }),
    );
  });

  it("uploads a logo via the engine and stores the URL", async () => {
    prisma.brandKit.upsert.mockResolvedValue({});
    const result = await service.uploadLogo("org1", "user1", {
      filename: "logo.png",
      dataBase64: "AAAA",
      contentType: "image/png",
    });
    expect(result).toEqual({ logoUrl: "http://minio/k.png" });
    expect(prisma.brandKit.upsert).toHaveBeenCalled();
  });

  it("rejects a non-image logo", async () => {
    await expect(
      service.uploadLogo("org1", "user1", {
        filename: "logo.svg",
        dataBase64: "AAAA",
        contentType: "image/svg+xml",
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
