"use client";

import { Loader2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Badge, Button, Card, ErrorNote, Input, Label } from "@/components/ui";

interface InvitePreview {
  orgName: string;
  email: string;
  role: string;
  inviterName: string | null;
  accountExists: boolean;
}

export default function InvitePage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const setSession = useAuthStore((s) => s.setSession);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/invitations/${token}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message ?? "Invitation not found");
        if (!cancelled) setPreview(data);
      } catch (e) {
        if (!cancelled) setInvalid(e instanceof Error ? e.message : "Invitation not found");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/accept-invitation`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          ...(preview?.accountExists ? {} : { name }),
          ...(mfaCode ? { mfaCode } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.message?.code === "MFA_REQUIRED" || data?.code === "MFA_REQUIRED") {
          setNeedsMfa(true);
          setError("Enter the 6-digit code from your authenticator app");
          return;
        }
        const message = data?.message?.message ?? data?.message ?? "Could not accept the invite";
        throw new ApiError(res.status, Array.isArray(message) ? message.join(", ") : message);
      }
      setSession(data);
      router.replace(data.organization.hasProfile ? "/dashboard" : "/onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept the invite");
    } finally {
      setLoading(false);
    }
  };

  if (invalid) {
    return (
      <Card>
        <h1 className="mb-1 text-lg font-semibold">Invitation unavailable</h1>
        <p className="text-sm text-ink-2">{invalid}</p>
        <p className="mt-4 text-sm text-ink-3">
          Ask the person who invited you to send a fresh link.
        </p>
      </Card>
    );
  }

  if (!preview) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </div>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Join {preview.orgName}</h1>
      <p className="mb-4 text-sm text-ink-2">
        {preview.inviterName ? `${preview.inviterName} invited you` : "You have been invited"} to
        join as <Badge status={preview.role} />
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={preview.email} disabled />
        </div>
        {!preview.accountExists && (
          <div>
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              required
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Mwangi"
            />
          </div>
        )}
        <div>
          <Label htmlFor="password">
            {preview.accountExists ? "Your password" : "Choose a password"}
          </Label>
          <Input
            id="password"
            type="password"
            required
            autoComplete={preview.accountExists ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
          />
          {!preview.accountExists && (
            <p className="mt-1 text-[14px] text-ink-3">
              At least 10 characters, with a lowercase letter and an uppercase letter or digit.
            </p>
          )}
        </div>
        {needsMfa && (
          <div>
            <Label htmlFor="mfa">MFA code</Label>
            <Input
              id="mfa"
              inputMode="numeric"
              maxLength={8}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              placeholder="123456"
            />
          </div>
        )}
        <ErrorNote message={error} />
        <Button type="submit" loading={loading} className="w-full">
          {preview.accountExists ? "Sign in & join" : "Create account & join"}
        </Button>
      </form>
    </Card>
  );
}
