import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { PasswordResetService } from "./password-reset.service";
import { AuthService } from "./auth.service";
import { LoginBackoffService } from "./login-backoff.service";
import { BreachedPasswordService } from "./breached-password.service";
import { BackupCodesService } from "./backup-codes.service";

@Module({
  controllers: [AuthController],
  providers: [PasswordResetService, AuthService, LoginBackoffService, BreachedPasswordService, BackupCodesService],
  exports: [AuthService],
})
export class AuthModule {}
