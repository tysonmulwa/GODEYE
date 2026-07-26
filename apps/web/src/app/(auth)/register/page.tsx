"use client";

import { Building2, Clapperboard } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { registerSchema, type AccountType } from "@godeye/shared";
import { AUTH_URL } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button, Card, ErrorNote, Input, Label, PasswordInput, cx } from "@/components/ui";

const ACCOUNT_TYPES: Array<{
  value: AccountType;
  label: string;
  hint: string;
  icon: typeof Building2;
}> = [
  {
    value: "CREATOR",
    label: "Content creator",
    hint: "I'm building my own audience — automate my posts, images & videos",
    icon: Clapperboard,
  },
  {
    value: "BUSINESS",
    label: "Business / company",
    hint: "We market a business — team seats, approvals & brand tools",
    icon: Building2,
  },
];

export default function RegisterPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [accountType, setAccountType] = useState<AccountType>("CREATOR");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    organizationName: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = registerSchema.safeParse({ ...form, accountType });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_URL}/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json();
      if (!res.ok) {
        const message = data?.message;
        throw new Error(Array.isArray(message) ? message[0] : (message ?? "Registration failed"));
      }
      setSession(data);
      router.replace("/onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Create your workspace</h1>
      <p className="mb-6 text-sm text-ink-2">
        One account. An entire AI marketing department.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label>I am a…</Label>
          <div className="grid grid-cols-2 gap-2">
            {ACCOUNT_TYPES.map(({ value, label, hint, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setAccountType(value)}
                className={cx(
                  "rounded-lg border p-3 text-left transition-colors",
                  accountType === value
                    ? "border-accent bg-accent/5"
                    : "border-line hover:border-ink-3",
                )}
              >
                <Icon
                  className={cx(
                    "mb-1.5 h-4 w-4",
                    accountType === value ? "text-accent" : "text-ink-3",
                  )}
                />
                <p className="text-xs font-semibold">{label}</p>
                <p className="mt-0.5 text-[14px] leading-snug text-ink-3">{hint}</p>
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label htmlFor="name">Your name</Label>
          <Input id="name" required value={form.name} onChange={set("name")} placeholder="Jane Doe" />
        </div>
        <div>
          <Label htmlFor="org">
            {accountType === "CREATOR" ? "Brand name (optional)" : "Business / organization name"}
          </Label>
          <Input
            id="org"
            required={accountType === "BUSINESS"}
            value={form.organizationName}
            onChange={set("organizationName")}
            placeholder={accountType === "CREATOR" ? "Defaults to your name" : "Acme Inc"}
          />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set("email")}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            required
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
            placeholder="At least 10 characters"
          />
        </div>
        <ErrorNote message={error} />
        <Button type="submit" loading={loading} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-2">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
