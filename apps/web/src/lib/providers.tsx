"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { tryRefresh } from "./api";
import { useAuthStore } from "./auth-store";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  // Restore the session from the refresh cookie on first load
  useEffect(() => {
    if (useAuthStore.getState().status !== "loading") return;
    tryRefresh().then((ok) => {
      if (!ok) useAuthStore.getState().clear();
    });
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
