import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  inviteMemberSchema,
  orgSettingsSchema,
  updateMemberRoleSchema,
  type InviteMemberInput,
  type OrgSettingsInput,
  type UpdateMemberRoleInput,
} from "@godeye/shared";
import { CurrentAuth } from "../common/current-auth.decorator";
import { AccessTokenPayload, JwtAuthGuard } from "../common/jwt-auth.guard";
import { MinRole, RolesGuard } from "../common/roles.guard";
import { ZodPipe } from "../common/zod.pipe";
import { MembersService } from "./members.service";

@ApiTags("members")
@Controller("members")
@ApiBearerAuth()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @MinRole("VIEWER")
  @ApiOperation({ summary: "List members and pending invitations" })
  list(@CurrentAuth() auth: AccessTokenPayload) {
    return this.members.list(auth.orgId);
  }

  @Post("invitations")
  @MinRole("ADMIN")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Invite a teammate, returns a one-time invite link" })
  invite(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(inviteMemberSchema)) body: InviteMemberInput,
  ) {
    return this.members.invite(auth, body);
  }

  @Delete("invitations/:id")
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Revoke a pending invitation" })
  revokeInvitation(@CurrentAuth() auth: AccessTokenPayload, @Param("id") id: string) {
    return this.members.revokeInvitation(auth, id);
  }

  @Patch(":userId")
  // Who holds which role is the owner's decision. An ADMIN promoting themselves
  // to OWNER would be a one-request takeover of the workspace.
  @MinRole("OWNER")
  @ApiOperation({ summary: "Change a member's role" })
  changeRole(
    @CurrentAuth() auth: AccessTokenPayload,
    @Param("userId") userId: string,
    @Body(new ZodPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
  ) {
    return this.members.changeRole(auth, userId, body);
  }

  @Delete(":userId")
  // VIEWER at the route because anyone may leave a workspace they are in.
  // Removing *someone else* needs ADMIN and needs to outrank them, which
  // MembersService.remove enforces — see docs/security/AUTHORIZATION.md.
  @MinRole("VIEWER")
  @ApiOperation({ summary: "Remove a member (admins) or leave the org (yourself)" })
  remove(@CurrentAuth() auth: AccessTokenPayload, @Param("userId") userId: string) {
    return this.members.remove(auth, userId);
  }

  @Patch("org/settings")
  @MinRole("ADMIN")
  @ApiOperation({ summary: "Update org settings (require content approval)" })
  updateSettings(
    @CurrentAuth() auth: AccessTokenPayload,
    @Body(new ZodPipe(orgSettingsSchema)) body: OrgSettingsInput,
  ) {
    return this.members.updateSettings(auth, body);
  }
}
