import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { BillingService } from "../billing/billing.module";
import { AuditService } from "../common/audit.service";
import { CryptoService } from "../common/crypto.service";
import { PrismaService } from "../common/prisma.service";
import { EngineService } from "../engine/engine.service";
import { ConnectionsService } from "./connections.service";

/**
 * What a channel card is allowed to say is wrong with it.
 *
 * lastError is stamped on a failed post and cleared on a successful one, so a
 * channel that failed once and has not posted since kept that message forever.
 * It sat on two workspaces for days, in red, beside a badge reading ACTIVE,
 * describing an attempt nobody remembered.
 */
describe("ConnectionsService, which errors are worth showing", () => {
  let service: ConnectionsService;
  let prisma: { socialConnection: { findMany: jest.Mock } };

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  const connection = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "c1",
    platform: "TIKTOK",
    status: "ACTIVE",
    displayName: "@shop",
    externalId: "1",
    lastError: null,
    lastErrorAt: null,
    createdAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    prisma = { socialConnection: { findMany: jest.fn() } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: JwtService, useValue: {} },
        { provide: EngineService, useValue: {} },
        { provide: BillingService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(ConnectionsService);
  });

  async function listOne(over: Partial<Record<string, unknown>>) {
    prisma.socialConnection.findMany.mockResolvedValue([connection(over)]);
    const [row] = await service.list("org1");
    return row;
  }

  it("shows a failure that just happened", async () => {
    const row = await listOne({ lastError: "TikTok rejected the post", lastErrorAt: hoursAgo(1) });
    expect(row.lastError).toBe("TikTok rejected the post");
  });

  it("stops showing it once it is yesterday's news", async () => {
    // The complaint: the same red line on an ACTIVE channel, for days.
    const row = await listOne({ lastError: "TikTok rejected the post", lastErrorAt: hoursAgo(72) });
    expect(row.lastError).toBeNull();
  });

  it("keeps showing it on a channel that is not active, however old", async () => {
    // EXPIRED and DISCONNECTED are the states where the message is the whole
    // explanation, and age says nothing about whether it still applies.
    for (const status of ["EXPIRED", "ERROR", "DISCONNECTED"]) {
      const row = await listOne({
        status,
        lastError: "Reconnect this account",
        lastErrorAt: hoursAgo(500),
      });
      expect(row.lastError).toBe("Reconnect this account");
    }
  });

  it("shows nothing when nothing has failed", async () => {
    expect((await listOne({})).lastError).toBeNull();
  });

  it("does not show an error with no time attached on a working channel", async () => {
    // Undateable means unjudgeable, and an ACTIVE channel is the platform
    // saying it is fine.
    const row = await listOne({ lastError: "something old", lastErrorAt: null });
    expect(row.lastError).toBeNull();
  });
});
