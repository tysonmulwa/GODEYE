import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LoginBackoffService } from "./login-backoff.service";
import { BreachedPasswordService } from "./breached-password.service";
import { BackupCodesService } from "./backup-codes.service";

@Module({
  controllers: [AuthController],
  providers: [AuthService, LoginBackoffService, BreachedPasswordService, BackupCodesService],
  exports: [AuthService],
})
export class AuthModule {}
