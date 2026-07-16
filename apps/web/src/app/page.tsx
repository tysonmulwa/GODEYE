"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthStore } from "@/lib/auth-store";
import { Loader2 } from "lucide-react";

export default function Home() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const org = useAuthStore((s) => s.organization);

  useEffect(() => {
    if (status === "guest") router.replace("/login");
    if (status === "authed") router.replace(org?.hasProfile ? "/dashboard" : "/onboarding");
  }, [status, org, router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
    </div>
  );
}
