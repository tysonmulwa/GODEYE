"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore, type SessionUser } from "@/lib/auth-store";
import { useToast } from "@/lib/toast";
import { Button, Card, ErrorNote, Input, Label, PasswordInput } from "@/components/ui";

/**
 * Your own account: who you are, where you sign in, and the password.
 *
 * Split into three saves rather than one form. Changing your name is a typo
 * fix; changing your email or password is an account action that needs the
 * password, and burying that in a general Save would mean asking for it every
 * time somebody corrects a spelling.
 */
export function AccountCard() {
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);
  const toast = useToast();

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const saveName = useMutation({
    mutationFn: () => api<SessionUser>("/auth/me", { method: "PATCH", body: { name } }),
    onSuccess: (updated) => {
      patchUser(updated);
      setError(null);
      toast.success("Name updated.");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not save"),
  });

  const saveEmail = useMutation({
    mutationFn: () =>
      api<SessionUser>("/auth/change-email", {
        method: "POST",
        body: { email, password: emailPassword },
      }),
    onSuccess: (updated) => {
      patchUser(updated);
      setEmailPassword("");
      setError(null);
      toast.success(`You now sign in as ${updated.email}.`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not change your email"),
  });

  const savePassword = useMutation({
    mutationFn: () =>
      api<{ sessionsEnded: number }>("/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      }),
    onSuccess: ({ sessionsEnded }) => {
      setCurrentPassword("");
      setNewPassword("");
      setError(null);
      // Worth saying out loud: if they did this because someone else had the
      // password, this number is the answer to "did that actually help".
      toast.success(
        sessionsEnded > 0
          ? `Password changed. ${sessionsEnded} other session${
              sessionsEnded === 1 ? " was" : "s were"
            } signed out.`
          : "Password changed.",
      );
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not change your password"),
  });

  if (!user) return null;

  const nameChanged = name.trim() !== user.name && name.trim().length >= 2;
  const emailChanged = email.trim().toLowerCase() !== user.email.toLowerCase();

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Your account</h2>
      <p className="mb-4 text-xs text-ink-3">
        This is you, not the workspace. Changing it here changes it everywhere you
        are a member.
      </p>

      <div className="space-y-2">
        <Label>Name</Label>
        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="flex-1"
          />
          <Button
            variant="secondary"
            className="h-9"
            disabled={!nameChanged}
            loading={saveName.isPending}
            onClick={() => saveName.mutate()}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="mt-5 space-y-2 border-t border-line pt-5">
        <Label>Email</Label>
        <p className="text-xs text-ink-3">
          The address you sign in with, and where an account recovery would go.
        </p>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        {emailChanged && (
          <div className="flex gap-2">
            <PasswordInput
              value={emailPassword}
              onChange={(e) => setEmailPassword(e.target.value)}
              placeholder="Your password, to confirm"
              autoComplete="current-password"
              className="flex-1"
            />
            <Button
              variant="secondary"
              className="h-9"
              disabled={!emailPassword}
              loading={saveEmail.isPending}
              onClick={() => saveEmail.mutate()}
            >
              Change
            </Button>
          </div>
        )}
      </div>

      <div className="mt-5 space-y-2 border-t border-line pt-5">
        <Label>Password</Label>
        <p className="text-xs text-ink-3">
          Changing it signs out every other device. This one stays signed in.
        </p>
        <PasswordInput
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
        />
        <PasswordInput
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password"
          autoComplete="new-password"
        />
        <Button
          variant="secondary"
          className="h-9"
          disabled={!currentPassword || newPassword.length < 8}
          loading={savePassword.isPending}
          onClick={() => savePassword.mutate()}
        >
          Change password
        </Button>
      </div>

      <div className="mt-3">
        <ErrorNote message={error} />
      </div>
    </Card>
  );
}
