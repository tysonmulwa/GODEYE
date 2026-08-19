import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuditService } from "./audit.service";
import { CryptoService } from "./crypto.service";
import { MembershipService } from "./membership.service";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  imports: [JwtModule.register({ global: true })],
  providers: [PrismaService, CryptoService, AuditService, MembershipService],
  exports: [PrismaService, CryptoService, AuditService, MembershipService],
})
export class CommonModule {}
