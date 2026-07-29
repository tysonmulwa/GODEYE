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
  @Get("tiktok:token.txt")
  @Header("Content-Type", "text/plain; charset=utf-8")
  tiktok(@Param("token") token: string): string {
    const expected = (process.env.TIKTOK_VERIFICATION ?? "").trim();
    // Compare the token from the filename so only the issued file resolves,
    // rather than serving the secret from any tiktok*.txt path.
    if (!expected || token !== expected) {
      throw new NotFoundException("Not found");
    }
    return `tiktok-developers-site-verification=${expected}`;
  }
}
