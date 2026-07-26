"use client";

import { useAuthStore } from "./auth-store";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Base for auth calls — empty, i.e. this origin. next.config rewrites /auth/*
 * to the API so the refresh cookie is first-party; hitting the API host
 * directly would make it third-party and browsers would drop it.
 */
export const AUTH_URL = "";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** skip the automatic refresh-and-retry on 401 */
  noRetry?: boolean;
}

/** Authenticated JSON client. On 401 it refreshes the session once and retries. */
export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401 && !options.noRetry && path !== "/auth/refresh") {
    const refreshed = await tryRefresh();
    if (refreshed) return api<T>(path, { ...options, noRetry: true });
    useAuthStore.getState().clear();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message =
      (data && (data.message?.message ?? data.message)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, Array.isArray(message) ? message.join(", ") : message, data);
  }
  return data as T;
}

let refreshPromise: Promise<boolean> | null = null;

export function tryRefresh(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${AUTH_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return false;
      const session = await res.json();
      useAuthStore.getState().setSession(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}
