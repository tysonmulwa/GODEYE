"use client";

import { create } from "zustand";
import type { WorkspaceAccess } from "@godeye/shared";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  mfaEnabled: boolean;
}

export interface SessionOrg {
  id: string;
  name: string;
  slug: string;
  role: string;
  type?: "BUSINESS" | "CREATOR";
  hasProfile: boolean;
  requireApproval?: boolean;
  /**
   * Trial clock and read-only state, as the API computed it.
   *
   * Optional because a session restored by an older API build will not carry
   * it, and a missing field must read as "no reason to warn anybody" rather
   * than as an expired trial. The API refuses the write either way, this is
   * only what the app uses to explain itself.
   */
  access?: WorkspaceAccess;
}

interface SessionPayload {
  user: SessionUser;
  organization: SessionOrg;
  accessToken: string;
}

interface AuthState {
  status: "loading" | "authed" | "guest";
  user: SessionUser | null;
  organization: SessionOrg | null;
  accessToken: string | null;
  setSession: (session: SessionPayload) => void;
  markProfileComplete: () => void;
  setRequireApproval: (v: boolean) => void;
  // Paying should lift the read-only state in the tab that paid, without
  // waiting for the next session refresh.
  setAccess: (access: WorkspaceAccess) => void;
  // Editing your own name or email has to show immediately. Without this the
  // only way to refresh the cached user was to sign out and back in.
  patchUser: (patch: Partial<SessionUser>) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  user: null,
  organization: null,
  accessToken: null,
  setSession: (session) =>
    set({
      status: "authed",
      user: session.user,
      organization: session.organization,
      accessToken: session.accessToken,
    }),
  markProfileComplete: () =>
    set((s) => ({
      organization: s.organization ? { ...s.organization, hasProfile: true } : s.organization,
    })),
  setRequireApproval: (v) =>
    set((s) => ({
      organization: s.organization ? { ...s.organization, requireApproval: v } : s.organization,
    })),
  setAccess: (access) =>
    set((s) => ({ organization: s.organization ? { ...s.organization, access } : s.organization })),
  patchUser: (patch) => set((s) => ({ user: s.user ? { ...s.user, ...patch } : s.user })),
  clear: () => set({ status: "guest", user: null, organization: null, accessToken: null }),
}));
