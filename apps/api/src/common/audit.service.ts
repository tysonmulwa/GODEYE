import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

interface AuditEntry {
  orgId?: string;
  userId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget, auditing must never break the main request path. */
  log(entry: AuditEntry): void {
    this.prisma.auditLog
      .create({
        data: {
          orgId: entry.orgId,
          userId: entry.userId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          ip: entry.ip,
          userAgent: entry.userAgent,
          metadata: (entry.metadata ?? undefined) as never,
        },
      })
      .catch((e) => this.logger.warn(`Audit write failed: ${e.message}`));
  }
}
