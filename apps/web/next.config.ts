import type { NextConfig } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  transpilePackages: ["@godeye/shared"],
  env: {
    NEXT_PUBLIC_API_URL: API_URL,
  },
  // No /auth rewrite: the web app and API share one registrable domain
  // (godeyeautomation.com + api.godeyeautomation.com), so the session cookie is
  // already first-party and the browser talks to the API directly. Proxying
  // through this origin was only a workaround for hosting them on unrelated
  // domains, and on Workers a failing proxy target surfaces as a Cloudflare
  // HTML error page rather than a usable API error.
};

export default nextConfig;
