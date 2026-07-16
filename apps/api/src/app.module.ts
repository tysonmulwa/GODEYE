import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BusinessProfileModule } from "./business-profile/business-profile.module";
import { CommonModule } from "./common/common.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ContentModule } from "./content/content.module";
import { EngineModule } from "./engine/engine.module";
import { MediaModule } from "./media/media.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SchedulingModule } from "./scheduling/scheduling.module";
import { SeoModule } from "./seo/seo.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    CommonModule,
    EngineModule,
    AuthModule,
    BusinessProfileModule,
    ConnectionsModule,
    ContentModule,
    MediaModule,
    SchedulingModule,
    SeoModule,
    RealtimeModule,
    WebhooksModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
