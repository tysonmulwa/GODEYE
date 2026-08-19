"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AUTH_URL, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { GodeyeSpinner } from "@/components/logo";
import { Badge, Button, Card, ErrorNote, Input, Label, PasswordInput } from "@/components/ui";

interface InvitePreview {
  orgName: string;
  email: string;
  role: string;
  inviterName: string | null;
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
        const res = await fetch(`${AUTH_URL}/auth/invitations/${token}`);
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
      const res = await fetch(`${AUTH_URL}/auth/accept-invitation`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          // Sent when the person filled it in. The server decides whether it
          // needs one: it knows whether the address already has an account,
          // and telling the browser that was a user-enumeration oracle (S-16).
          ...(name.trim() ? { name: name.trim() } : {}),
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
        <GodeyeSpinner size={34} className="text-ink-2" />
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
        <div>
          <Label htmlFor="name">Your name</Label>
          <Input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Mwangi"
          />
          <p className="mt-1 text-[14px] text-ink-3">Only needed if this is your first workspace.</p>
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
          />
          <p className="mt-1 text-[14px] text-ink-3">
            If you already have a GODEYE account, use that password. If not, choose one now: at
            least 10 characters, with a lowercase letter and an uppercase letter or digit.
          </p>
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
          Join workspace
        </Button>
      </form>
    </Card>
  );
}
