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

const DOMAIN_ASSOCIATION =
  '{"version":1,"pspId":"4BE8DFE7C705DD585139674DF649F2B7DF89B44591CC26245B848EB2586E087B","createdOn":1786546082458}';

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
