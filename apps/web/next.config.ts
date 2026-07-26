import type { NextConfig } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  transpilePackages: ["@godeye/shared"],
  env: {
    NEXT_PUBLIC_API_URL: API_URL,
  },
  /**
   * Proxy only the auth endpoints through this origin.
   *
   * The session refresh token is an httpOnly cookie. With the web app on
   * vercel.app and the API on railway.app it is a third-party cookie, and
   * browsers now block those by default — so every page reload lost the session
   * and bounced the user to /login. Serving /auth/* from this origin makes the
   * cookie first-party and the session survives.
   *
   * Deliberately limited to /auth: everything else authenticates with a bearer
   * token and needs no cookie, and routing large media uploads through the
   * proxy would run into the platform's request body limits.
   */
  async rewrites() {
    return [{ source: "/auth/:path*", destination: `${API_URL}/auth/:path*` }];
  },
};

export default nextConfig;
