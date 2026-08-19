import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";

@Module({
  // For disconnectUser: removing somebody must also close their sockets.
  imports: [RealtimeModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
