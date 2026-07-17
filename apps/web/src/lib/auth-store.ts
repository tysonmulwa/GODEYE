"use client";

import { create } from "zustand";

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
  clear: () => set({ status: "guest", user: null, organization: null, accessToken: null }),
}));
