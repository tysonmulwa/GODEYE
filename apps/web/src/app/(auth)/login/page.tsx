"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AUTH_URL, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button, Card, ErrorNote, Input, Label, PasswordInput } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, ...(mfaCode ? { mfaCode } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.message?.code === "MFA_REQUIRED" || data?.code === "MFA_REQUIRED") {
          setNeedsMfa(true);
          setError("Enter the 6-digit code from your authenticator app");
          return;
        }
        throw new ApiError(res.status, data?.message ?? "Login failed");
      }
      setSession(data);
      router.replace(data.organization.hasProfile ? "/dashboard" : "/onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Welcome back</h1>
      <p className="mb-6 text-sm text-ink-2">Sign in to your GODEYE workspace</p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
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
        <p className="-mt-1 text-right text-sm">
          <Link href="/forgot-password" className="text-ink-2 hover:text-accent hover:underline">
            Forgot your password?
          </Link>
        </p>
        <Button type="submit" loading={loading} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-2">
        New to GODEYE?{" "}
        <Link href="/register" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </Card>
  );
}
