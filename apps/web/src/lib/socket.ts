"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL } from "./api";
import { useAuthStore } from "./auth-store";

export interface RealtimeEvent {
  type: "agent_run.completed" | "scheduled_post.updated" | "media_asset.created";
  [key: string]: unknown;
}

let socket: Socket | null = null;

/** Joins the org realtime room and invalidates queries when the engine reports progress. */
export function useRealtime(onEvent?: (event: RealtimeEvent) => void) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!accessToken) return;
    socket?.disconnect();
    socket = io(`${API_URL}/realtime`, {
      auth: { token: accessToken },
      transports: ["websocket"],
    });
    const handler = (event: RealtimeEvent) => {
      if (event.type === "agent_run.completed") {
        queryClient.invalidateQueries({ queryKey: ["content"] });
        queryClient.invalidateQueries({ queryKey: ["agent-run"] });
      }
      if (event.type === "scheduled_post.updated") {
        queryClient.invalidateQueries({ queryKey: ["schedule"] });
      }
      if (event.type === "media_asset.created") {
        queryClient.invalidateQueries({ queryKey: ["media"] });
        queryClient.invalidateQueries({ queryKey: ["agent-run"] });
      }
      onEvent?.(event);
    };
    socket.on("event", handler);
    return () => {
      socket?.off("event", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);
}
