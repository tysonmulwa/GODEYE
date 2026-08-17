/**
 * Apple Pay merchant domain association.
 *
 * Paystack verifies Apple Pay domains by fetching
 * `/.well-known/apple-developer-merchantid-domain-association` and comparing the
 * bytes against the file it issued. Until that fetch succeeds, Apple Pay does
 * not appear as a payment option on the checkout.
 *
 * Served from a route handler rather than `public/.well-known/`, deliberately.
 * The path starts with a dot, and Cloudflare Workers Assets does not reliably
 * publish dot-directories, so the file would 404 in production while working
 * perfectly on a local `next dev`. A rewrite in next.config maps the real path
 * here, which keeps it inside the Worker where nothing is filtered.
 *
 * The content is public by design. It identifies Paystack as the payment
 * service provider for this domain and carries no secret.
 */

/**
 * The file Paystack issued, byte for byte.
 *
 * This is hex text and it is served as hex text. It decodes to
 * {"version":1,"pspId":"4BE8...087B","createdOn":1786546082458}, and serving
 * that decoded JSON instead is what failed verification the first time: the
 * check is a byte comparison against the issued file, and the issued file is
 * 228 characters of hex, not the 114 bytes it represents. Do not "fix" this by
 * decoding it.
 *
 * No trailing newline, for the same reason. The downloaded file has none.
 */
const DOMAIN_ASSOCIATION =
  "7b2276657273696f6e223a312c227073704964223a223442453844464537433730354444" +
  "3538353133393637344446363439463242374446383942343435393143433236323435" +
  "423834384542323538364530383742222c22637265617465644f6e223a313738363534" +
  "363038323435387d";

export const dynamic = "force-static";

export function GET() {
  return new Response(DOMAIN_ASSOCIATION, {
    status: 200,
    headers: {
      // No extension on the path, so nothing can be inferred. Apple and
      // Paystack compare the body and do not require a particular type.
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
