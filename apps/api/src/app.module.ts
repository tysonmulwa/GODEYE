import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BillingModule } from "./billing/billing.module";
import { TrialLockInterceptor } from "./billing/trial-lock.interceptor";
import { BusinessProfileModule } from "./business-profile/business-profile.module";
import { CommonModule } from "./common/common.module";
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
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
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Read-only once a workspace's trial ends unpaid. Global so a new
    // controller is covered the day it is written rather than the day somebody
    // remembers to decorate it.
    { provide: APP_INTERCEPTOR, useClass: TrialLockInterceptor },
  ],
})
export class AppModule {}
