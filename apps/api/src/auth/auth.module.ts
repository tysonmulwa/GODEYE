import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LoginBackoffService } from "./login-backoff.service";

@Module({
  controllers: [AuthController],
  providers: [AuthService, LoginBackoffService],
  exports: [AuthService],
})
export class AuthModule {}
