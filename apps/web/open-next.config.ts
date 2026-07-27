import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Transforms the Next.js build into a Cloudflare Worker.
 *
 * Defaults are deliberate: GODEYE's pages are either static or client-rendered
 * against the API, so there is no ISR or server cache worth wiring up to R2/KV.
 */
export default defineCloudflareConfig();
