import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LoginBackoffService } from "./login-backoff.service";
import { BreachedPasswordService } from "./breached-password.service";

@Module({
  controllers: [AuthController],
  providers: [AuthService, LoginBackoffService, BreachedPasswordService],
  exports: [AuthService],
})
export class AuthModule {}
