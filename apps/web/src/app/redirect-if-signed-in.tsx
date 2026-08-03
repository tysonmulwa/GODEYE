"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/auth-store";

/**
 * Sends a signed-in visitor to their workspace, and everyone else nowhere.
 *
 * The landing page used to be this logic and nothing else: a client component
 * that rendered a spinner and redirected. A crawler ran no JavaScript, so the
 * homepage was two words of loading text, which is why it could not rank for
 * anything. The page is server-rendered content now and the redirect is this
 * — a behaviour bolted onto real content rather than standing in for it.
 *
 * A signed-out visitor is deliberately left alone. Bouncing them to /login
 * would put the same emptiness back, one URL along.
 */
export function RedirectIfSignedIn() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const org = useAuthStore((s) => s.organization);

  useEffect(() => {
    if (status !== "authed") return;
    router.replace(org?.hasProfile ? "/dashboard" : "/onboarding");
  }, [status, org, router]);

  return null;
}
