import { NextResponse, type NextRequest } from "next/server";
import { securityHeaders } from "./lib/csp";

/**
 * Attaches the security headers to every HTML response.
 *
 * Thin on purpose — the policy itself lives in `lib/csp.ts` where it can be
 * tested. This file does the two things that need a request: mint a nonce, and
 * hand it to Next.
 *
 * ## Why the CSP is also set on the *request*
 *
 * Next reads `content-security-policy` off the incoming request headers, finds
 * the `nonce-...` token in it, and stamps that nonce onto every script tag it
 * renders. Without that, `'strict-dynamic'` blocks Next's own bootstrap and the
 * page is a white screen.
 *
 * It is set on the request even in report-only mode, where the browser will
 * never see it as a rule. That is the point: the report-only run is worthless
 * if Next's own scripts are unnonced, because the report would be full of
 * violations from the framework rather than from the application, and
 * promoting the policy would then break the app in exactly the way the dry run
 * was supposed to rule out.
 */
export function middleware(request: NextRequest) {
  // 16 bytes from the platform CSPRNG, per response. A nonce that repeats is a
  // nonce an injected script can copy from the page it landed on, which is the
  // same as having no nonce at all.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

  const isDev = process.env.NODE_ENV !== "production";
  const headers = securityHeaders({
    nonce,
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
    isDev,
    // A variable rather than a code change, so promoting the policy from a
    // report to a rule is something an operator can do — and undo in seconds
    // if a page breaks. docs/security/CSP.md is the runbook.
    enforce: process.env.CSP_ENFORCE === "true",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", headers["Content-Security-Policy"]);
  // In report-only mode the enforcing header is the baseline, which carries no
  // nonce — so hand Next the full policy explicitly or it has no nonce to find.
  if (headers["Content-Security-Policy-Report-Only"]) {
    requestHeaders.set(
      "content-security-policy",
      headers["Content-Security-Policy-Report-Only"],
    );
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: [
    /**
     * HTML only.
     *
     * Static assets and images are served with their own caching, and running
     * middleware over them would mint a nonce per asset for no reason — on
     * Workers that is billable CPU on every file in the bundle.
     *
     * `.well-known` is excluded because Paystack fetches the Apple Pay domain
     * association file and compares the bytes; nothing should be decorating
     * that response.
     */
    "/((?!_next/static|_next/image|favicon.ico|\\.well-known|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|txt|xml|webmanifest)$).*)",
  ],
};
