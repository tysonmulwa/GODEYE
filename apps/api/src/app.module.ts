import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { ThrottlerModule, ThrottlerStorage } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BillingModule } from "./billing/billing.module";
import { TrialLockInterceptor } from "./billing/trial-lock.interceptor";
import { BusinessProfileModule } from "./business-profile/business-profile.module";
import { CommonModule } from "./common/common.module";
import { MetricsInterceptor } from "./common/metrics.interceptor";
import { RolesGuard } from "./common/roles.guard";
import { GodeyeThrottlerGuard } from "./common/throttler.guard";
import { RedisThrottlerStorage } from "./common/throttler-storage";
import { RouteAuditService } from "./common/route-audit.service";
import { StructuredLogger } from "./common/logger";
import { ConnectionsModule } from "./connections/connections.module";
import { ContentModule } from "./content/content.module";
import { EngineModule } from "./engine/engine.module";
import { HealthController } from "./health.controller";
import { MediaModule } from "./media/media.module";
import { MembersModule } from "./members/members.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SchedulingModule } from "./scheduling/scheduling.module";
import { SiteVerificationController } from "./common/site-verification.controller";
import { ProductsModule } from "./products/products.module";
import { SeoModule } from "./seo/seo.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    DiscoveryModule, // route enumeration for the boot-time authorization audit
    // Three layers, because one bucket is what S-4 was.
    //
    //   default  per (caller, route).  The 26 existing @Throttle overrides tune
    //            this one, and nothing else, so their meaning is unchanged.
    //   burst    per caller, across every route. Stops somebody staying under
    //            each individual limit while hammering the API as a whole.
    //   spend    per caller, across every route that declares a @Cost(). Money
    //            and GPU time, counted in units rather than requests, over an
    //            hour rather than a minute (OWASP API4).
    ThrottlerModule.forRoot({
      throttlers: [
        { name: "default", ttl: 60_000, limit: 100 },
        { name: "burst", ttl: 60_000, limit: 600 },
        { name: "spend", ttl: 3_600_000, limit: 240 },
      ],
    }),
    CommonModule,
    EngineModule,
    AuthModule,
    BillingModule,
    BusinessProfileModule,
    ConnectionsModule,
    ContentModule,
    MediaModule,
    MembersModule,
    SchedulingModule,
    ProductsModule,
    SeoModule,
    RealtimeModule,
    WebhooksModule,
  ],
  controllers: [SiteVerificationController, HealthController],
  providers: [
    // Order matters: guards run in registration order.
    //
    // RolesGuard first, so the throttler can key on the authenticated user and
    // org rather than on an IP alone. It is registered globally rather than
    // per-controller because per-controller wiring is what produced S-1 — five
    // controllers where @MinRole would have compiled and enforced nothing.
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: GodeyeThrottlerGuard },
    // Refuses to boot if any route declares neither @Public() nor @MinRole().
    RouteAuditService,
    StructuredLogger,
    // Counters in Redis, so limits are shared across replicas rather than
    // multiplied by them.
    { provide: ThrottlerStorage, useClass: RedisThrottlerStorage },
    // RED metrics on every endpoint. First in the interceptor chain so its
    // timer spans everything after it, including the trial-lock check.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    // Read-only once a workspace's trial ends unpaid. Global so a new
    // controller is covered the day it is written rather than the day somebody
    // remembers to decorate it.
    { provide: APP_INTERCEPTOR, useClass: TrialLockInterceptor },
  ],
})
export class AppModule {}
