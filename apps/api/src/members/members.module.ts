import { Module } from "@nestjs/common";
import { RolesGuard } from "../common/roles.guard";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";

@Module({
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
