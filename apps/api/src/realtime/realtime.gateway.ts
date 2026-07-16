import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import Redis from "ioredis";
import { Server, Socket } from "socket.io";
import { env } from "../common/env";
import { AccessTokenPayload } from "../common/jwt-auth.guard";

export const EVENTS_CHANNEL = "godeye:events";

/**
 * Pushes engine events to browsers in real time.
 * The Python engine publishes JSON to the `godeye:events` Redis channel:
 *   { "orgId": "...", "event": { "type": "...", ... } }
 * Browsers join a room per organization after JWT auth.
 */
@WebSocketGateway({
  namespace: "/realtime",
  cors: { origin: [env.webUrl], credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  private subscriber: Redis | null = null;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error("missing token");
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: env.jwtAccessSecret(),
      });
      await client.join(`org:${payload.orgId}`);
      client.emit("connected", { orgId: payload.orgId });
    } catch {
      client.emit("error", { message: "Unauthorized" });
      client.disconnect(true);
    }
  }

  onModuleInit() {
    this.subscriber = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 1000, 15_000),
    });
    this.subscriber.on("error", (e) => this.logger.warn(`Redis subscriber: ${e.message}`));
    this.subscriber
      .connect()
      .then(() => this.subscriber?.subscribe(EVENTS_CHANNEL))
      .catch((e) => this.logger.warn(`Redis unavailable, realtime disabled: ${e.message}`));

    this.subscriber.on("message", (_channel, raw) => {
      try {
        const { orgId, event } = JSON.parse(raw) as { orgId: string; event: unknown };
        if (orgId && event) this.server.to(`org:${orgId}`).emit("event", event);
      } catch (e) {
        this.logger.warn(`Bad realtime payload: ${(e as Error).message}`);
      }
    });
  }

  onModuleDestroy() {
    this.subscriber?.disconnect();
  }
}
