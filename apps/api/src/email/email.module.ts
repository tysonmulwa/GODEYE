import { Global, Module } from "@nestjs/common";
import { EmailService } from "./email.service";

/**
 * Global, because four unrelated modules send mail (auth, billing, members,
 * scheduling) and threading an import through each of them buys nothing. The
 * service holds no request state.
 */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
