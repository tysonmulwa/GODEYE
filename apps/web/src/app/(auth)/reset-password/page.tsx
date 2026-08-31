"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AUTH_URL } from "@/lib/api";
import { Button, Card, ErrorNote, Label, PasswordInput } from "@/components/ui";

/**
 * "I forgot my password", step two.
 *
 * ## The token stays in the URL and is never stored
 *
 * It is read from the query string and posted straight back. It is not written
 * to localStorage or to a cookie: the link is single-use and short-lived, and
 * copying it anywhere with a longer life than the reset itself only widens the
 * window in which it can be stolen.
 *
 * ## Every rejection reads the same
 *
 * Expired, already used, and never existed are one message. The API answers
 * that way too, and repeating the distinction here would give it back: a
 * message that says "expired" confirms the token was real, which tells someone
 * guessing that they were close.
 */
function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Checked here as well as on the server, because a typo in a password you
    // cannot see is the single most likely thing to go wrong on this screen.
    if (password !== confirm) {
      setError("Those two passwords are not the same.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${AUTH_URL}/auth/reset-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data?.message === "string"
            ? data.message
            : "That reset link is no longer valid. Request a new one.",
        );
        return;
      }
      setDone(true);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Card>
        <h1 className="mb-1 text-lg font-semibold">This link is incomplete</h1>
        <p className="mb-6 text-sm text-ink-2">
          Open the link from your email directly, or request a new one.
        </p>
        <Link href="/forgot-password">
          <Button className="w-full">Request a new link</Button>
        </Link>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <h1 className="mb-1 text-lg font-semibold">Password changed</h1>
        <p className="mb-6 text-sm text-ink-2">
          You have been signed out everywhere else. Sign in with your new password.
        </p>
        <Link href="/login">
          <Button className="w-full">Sign in</Button>
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Choose a new password</h1>
      <p className="mb-6 text-sm text-ink-2">
        This link works once. Signing in again elsewhere will need the new password.
      </p>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNote message={error} />}
        <div>
          <Label htmlFor="password">New password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 10 characters"
          />
        </div>
        <div>
          <Label htmlFor="confirm">Repeat it</Label>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="The same again"
          />
        </div>
        <Button type="submit" loading={loading} className="w-full">
          Change my password
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-2">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </Card>
  );
}

/**
 * `useSearchParams` opts the route into client rendering, and Next requires a
 * Suspense boundary around it or the whole page is deopted at build time.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Card>Loading…</Card>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
