import { Controller, Get, Header, NotFoundException, Param } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

/**
 * Serves platform domain-verification files from the API host.
 *
 * These are normally hosted on the marketing site, but a platform verifies the
 * exact host it is given — and the OAuth redirect URI points at the API
 * (api.<domain>), not the web app. Serving the token here lets that host be
 * verified without standing up a second static site.
 *
 * Set TIKTOK_VERIFICATION to the token TikTok issues (the part after
 * "tiktok-developers-site-verification="). Unset, the route 404s.
 */
@ApiExcludeController()
@Controller()
export class SiteVerificationController {
  /**
   * Served at the host root and under the OAuth callback path, because TikTok
   * checks the file directly beneath whichever URL prefix was registered — and
   * registering the callback URL as the prefix is the natural thing to do.
   */
  @Get(["tiktok:token.txt", "connections/tiktok/callback/tiktok:token.txt"])
  @Header("Content-Type", "text/plain; charset=utf-8")
  tiktok(@Param("token") token: string): string {
    // Accept any of the tokens listed, so re-issuing one (TikTok mints a new
    // token per URL property) doesn't invalidate a property already verified.
    const allowed = (process.env.TIKTOK_VERIFICATION ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    // Match against the filename so the route can't be used to fish for the
    // token — you have to already know it.
    if (!allowed.includes(token)) {
      throw new NotFoundException("Not found");
    }
    return `tiktok-developers-site-verification=${token}`;
  }
}
