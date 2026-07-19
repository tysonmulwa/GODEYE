import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@godeye/db";
import { env } from "./env";

const CONNECT_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ datasourceUrl: env.databaseUrl() });
  }

  /**
   * Connect with retry/backoff. A transient DB blip (e.g. the Supabase pooler
   * returning P1001) must NOT crash the whole API at boot — Prisma connects
   * lazily on the first query, so if every retry fails we log and continue
   * rather than exiting the process; the API recovers once the DB responds.
   */
  async onModuleInit() {
    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        await this.$connect();
        if (attempt > 1) this.logger.log(`Database connected on attempt ${attempt}`);
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
        this.logger.warn(
          `Database connect attempt ${attempt}/${CONNECT_RETRIES} failed: ${message}`,
        );
        if (attempt < CONNECT_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
      }
    }
    this.logger.warn(
      "Could not establish an initial database connection — starting anyway; " +
        "queries will connect on demand once the database is reachable.",
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
