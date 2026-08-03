"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { GodeyeBootScreen } from "@/components/logo";
import { useAuthStore } from "@/lib/auth-store";

export default function Home() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const org = useAuthStore((s) => s.organization);

  useEffect(() => {
    if (status === "guest") router.replace("/login");
    if (status === "authed") router.replace(org?.hasProfile ? "/dashboard" : "/onboarding");
  }, [status, org, router]);

  return (
    <GodeyeBootScreen />
  );
}
