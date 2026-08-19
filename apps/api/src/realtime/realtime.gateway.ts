import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import Redis from "ioredis";
import { Server, Socket } from "socket.io";
import { env } from "../common/env";
import { AccessTokenPayload } from "../common/jwt-auth.guard";
import { MembershipService } from "../common/membership.service";
import { verifyToken } from "../common/tokens";

export const EVENTS_CHANNEL = "godeye:events";
/** Redis channel used to ask every replica to drop one person's sockets. */
export const DISCONNECT_CHANNEL = "godeye:disconnect";

/** How often a live socket's membership is re-checked. */
const REVALIDATE_MS = 60_000;
/**
 * A socket may not outlive this, whatever else happens. It matches the access
 * token's own lifetime: a connection authenticated once and held open forever
 * is a session with no expiry, which is what the token TTL exists to prevent.
 */
const MAX_SOCKET_LIFETIME_MS = 15 * 60_000;

/**
 * Pushes engine events to browsers in real time.
 *
 * The Python engine publishes JSON to the `godeye:events` Redis channel:
 *   { "orgId": "...", "event": { "type": "...", ... } }
 *
 * Findings fixed here:
 *
 * C-1 (socket path) — the handshake verified the token with the session secret
 *   and nothing else, so an OAuth `state` token opened a socket into the
 *   workspace it named. It now goes through verifyToken, which demands
 *   typ/iss/aud and pins HS256.
 *
 * S-17 — a socket was authenticated once and never re-checked, so a removed
 *   member's connection stayed joined to `org:<id>` indefinitely, receiving
 *   every event in a workspace they had been thrown out of. Sockets are now
 *   re-validated on a timer, capped at the access token's lifetime, and
 *   dropped the moment a membership changes.
 */
@Injectable()
@WebSocketGateway({
  namespace: "/realtime",
  cors: { origin: [env.webUrl], credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private revalidateTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly memberships: MembershipService,
  ) {}

  /** `user:<userId>:org:<orgId>` — the room a targeted disconnect addresses. */
  private userRoom(userId: string, orgId: string): string {
    return `user:${userId}:org:${orgId}`;
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error("missing token");

      // The same verification the HTTP guard performs. Anything else — an OAuth
      // state, an invite token, a token from another issuer — is refused here
      // too, rather than only on the REST surface (C-1).
      const payload = await verifyToken<AccessTokenPayload>(this.jwt, "access", token);

      const live = await this.memberships.current(payload.sub, payload.orgId);
      if (!live) throw new Error("no membership");
      if (live.sessionVersion !== (payload.sv ?? 0)) throw new Error("session superseded");

      await client.join(`org:${payload.orgId}`);
      await client.join(this.userRoom(payload.sub, payload.orgId));
      client.data.auth = { sub: payload.sub, orgId: payload.orgId, sv: payload.sv ?? 0 };
      client.data.connectedAt = Date.now();
      client.emit("connected", { orgId: payload.orgId });
    } catch {
      client.emit("error", { message: "Unauthorized" });
      client.disconnect(true);
    }
  }

  /**
   * Drop every socket this person holds in this workspace, on every replica.
   *
   * Called synchronously by MembersService, and broadcast over Redis because
   * the socket is very likely on a different instance than the request that
   * removed them.
   */
  disconnectUser(userId: string, orgId: string): void {
    this.dropLocally(userId, orgId);
    this.publisher
      ?.publish(DISCONNECT_CHANNEL, JSON.stringify({ userId, orgId }))
      .catch((e: unknown) =>
        this.logger.warn(
          `Could not broadcast a disconnect for ${userId}: ` +
            (e instanceof Error ? e.message : String(e)) +
            ` (their sockets on this instance were dropped, others expire within ` +
            `${REVALIDATE_MS / 1000}s)`,
        ),
      );
  }

  private dropLocally(userId: string, orgId: string): void {
    this.server?.in(this.userRoom(userId, orgId)).disconnectSockets(true);
  }

  /**
   * Re-check every open socket.
   *
   * A membership can end without anything calling disconnectUser — an
   * organization deleted, a row changed by a migration or by hand. The timer is
   * the backstop that makes "authenticated once" untrue in every case rather
   * than in the cases somebody remembered.
   */
  private async revalidateSockets(): Promise<void> {
    const sockets = await this.server?.fetchSockets();
    if (!sockets?.length) return;

    for (const socket of sockets) {
      const auth = socket.data.auth as { sub: string; orgId: string; sv: number } | undefined;
      const connectedAt = socket.data.connectedAt as number | undefined;
      if (!auth) {
        socket.disconnect(true);
        continue;
      }
      if (connectedAt && Date.now() - connectedAt > MAX_SOCKET_LIFETIME_MS) {
        socket.emit("error", { message: "Session expired, reconnect" });
        socket.disconnect(true);
        continue;
      }
      const live = await this.memberships.current(auth.sub, auth.orgId);
      if (!live || live.sessionVersion !== auth.sv) {
        socket.emit("error", { message: "Access to this workspace has changed" });
        socket.disconnect(true);
      }
    }
  }

  onModuleInit() {
    this.subscriber = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 1000, 15_000),
    });
    this.publisher = this.subscriber.duplicate();
    this.subscriber.on("error", (e) => this.logger.warn(`Redis subscriber: ${e.message}`));
    this.publisher.on("error", (e) => this.logger.warn(`Redis publisher: ${e.message}`));

    this.subscriber
      .connect()
      .then(() => this.subscriber?.subscribe(EVENTS_CHANNEL, DISCONNECT_CHANNEL))
      .catch((e) => this.logger.warn(`Redis unavailable, realtime disabled: ${e.message}`));
    this.publisher
      .connect()
      .catch((e) => this.logger.warn(`Redis publisher unavailable: ${e.message}`));

    this.subscriber.on("message", (channel, raw) => {
      try {
        if (channel === DISCONNECT_CHANNEL) {
          const { userId, orgId } = JSON.parse(raw) as { userId: string; orgId: string };
          if (userId && orgId) this.dropLocally(userId, orgId);
          return;
        }
        const { orgId, event } = JSON.parse(raw) as { orgId: string; event: unknown };
        if (orgId && event) this.server.to(`org:${orgId}`).emit("event", event);
      } catch (e) {
        this.logger.warn(`Bad realtime payload on ${channel}: ${(e as Error).message}`);
      }
    });

    this.revalidateTimer = setInterval(() => void this.revalidateSockets(), REVALIDATE_MS);
    this.revalidateTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    this.revalidateTimer = null;
    this.subscriber?.disconnect();
    this.publisher?.disconnect();
  }
}
