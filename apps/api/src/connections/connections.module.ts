import { Module } from "@nestjs/common";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { OAuthStateService, RedisStateStore, STATE_STORE } from "./oauth-state.service";

@Module({
  controllers: [ConnectionsController],
  providers: [
    ConnectionsService,
    OAuthStateService,
    { provide: STATE_STORE, useClass: RedisStateStore },
  ],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
