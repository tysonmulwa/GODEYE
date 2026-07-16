"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { registerSchema } from "@godeye/shared";
import { API_URL } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button, Card, ErrorNote, Input, Label } from "@/components/ui";

export default function RegisterPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
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
    const parsed = registerSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/register`, {
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
          <Label htmlFor="name">Your name</Label>
          <Input id="name" required value={form.name} onChange={set("name")} placeholder="Jane Doe" />
        </div>
        <div>
          <Label htmlFor="org">Business / organization name</Label>
          <Input
            id="org"
            required
            value={form.organizationName}
            onChange={set("organizationName")}
            placeholder="Acme Inc"
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
          <Input
            id="password"
            type="password"
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
