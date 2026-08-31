"use client";

import Link from "next/link";
import { useState } from "react";
import { AUTH_URL } from "@/lib/api";
import { Button, Card, ErrorNote, Input, Label } from "@/components/ui";

/**
 * "I forgot my password", step one.
 *
 * ## The confirmation is deliberately vague
 *
 * It says "if that address has an account" and never confirms whether one
 * exists. The API answers identically either way for the same reason: anything
 * else turns this form into a membership oracle, where someone with a list of
 * addresses learns which have GODEYE accounts.
 *
 * That is a real temptation to get wrong here, because "no account with that
 * email" is genuinely more helpful to the person who mistyped it. The cost is
 * that it is equally helpful to somebody enumerating customers, and they can
 * try far more addresses than a person can mistype.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_URL}/auth/forgot-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // 429 is worth surfacing: it is the one failure the person can act on,
      // by waiting. Everything else resolves to the same neutral confirmation.
      if (res.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
        return;
      }
      setSent(true);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <Card>
        <h1 className="mb-1 text-lg font-semibold">Check your inbox</h1>
        <p className="mb-6 text-sm text-ink-2">
          If that address has an account, a reset link is on its way. It works once and
          expires in 30 minutes.
        </p>
        <p className="text-sm text-ink-2">
          Nothing arrived? Check spam, then{" "}
          <button
            type="button"
            onClick={() => setSent(false)}
            className="font-medium text-accent hover:underline"
          >
            try another address
          </button>
          .
        </p>
        <p className="mt-5 text-center text-sm text-ink-2">
          <Link href="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Reset your password</h1>
      <p className="mb-6 text-sm text-ink-2">
        Enter the address you signed up with and we will send you a link.
      </p>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNote message={error} />}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        <Button type="submit" loading={loading} className="w-full">
          Send the link
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-2">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
