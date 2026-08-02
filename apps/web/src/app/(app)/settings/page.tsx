"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import {
  Button,
  Card,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  PasswordInput,
  Switch,
  cx,
} from "@/components/ui";

interface BrandKit {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  fontFamily: string | null;
  watermarkEnabled: boolean;
  musicUrl: string | null;
  musicName: string | null;
}

const MANAGE_ROLES = ["OWNER", "ADMIN"];

interface PlanLimits {
  postsPerMonth: number;
  aiTokensPerMonth: number;
  connections: number;
  seats: number;
}

interface BillingOverview {
  plan: { code: string; name: string; priceMonthlyUsd: string };
  subscriptionStatus: string | null;
  limits: PlanLimits;
  usage: PlanLimits;
  plans: Array<{ code: string; name: string; priceMonthlyUsd: string; limits: PlanLimits }>;
  stripeConfigured: boolean;
}

const USAGE_ROWS: Array<{ key: keyof PlanLimits; label: string }> = [
  { key: "postsPerMonth", label: "Posts this month" },
  { key: "aiTokensPerMonth", label: "AI tokens this month" },
  { key: "connections", label: "Connected channels" },
  { key: "seats", label: "Team seats" },
];

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className={cx("h-full rounded-full", pct >= 100 ? "bg-red-500" : "bg-accent")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function BillingCard() {
  const { organization } = useAuthStore();
  const canManage = MANAGE_ROLES.includes(organization?.role ?? "");
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<BillingOverview>({
    queryKey: ["billing"],
    queryFn: () => api("/billing"),
  });

  const checkout = useMutation({
    mutationFn: (planCode: string) =>
      api<{ url: string }>("/billing/checkout", { method: "POST", body: { planCode } }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Checkout failed"),
  });

  if (!data) return null;

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Plan & usage</h2>
        <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-semibold text-accent-hover">
          {data.plan.name} · ${data.plan.priceMonthlyUsd}/mo
        </span>
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Usage resets on the 1st of every month.
        {data.subscriptionStatus === "PAST_DUE" && (
          <span className="text-amber-600"> Payment past due — update your card.</span>
        )}
      </p>

      <div className="space-y-3">
        {USAGE_ROWS.map(({ key, label }) => (
          <div key={key}>
            <div className="mb-1 flex items-center justify-between text-[12px]">
              <span className="text-ink-2">{label}</span>
              <span className="tnum text-ink-3">
                {data.usage[key].toLocaleString()} / {data.limits[key].toLocaleString()}
              </span>
            </div>
            <UsageBar used={data.usage[key]} limit={data.limits[key]} />
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-2.5 border-t border-line-soft pt-4 sm:grid-cols-3">
        {data.plans.map((p) => {
          const current = p.code === data.plan.code;
          return (
            <div
              key={p.code}
              className={cx(
                "rounded-lg border p-3",
                current ? "border-accent-border bg-accent-soft-2" : "border-line",
              )}
            >
              <div className="flex items-baseline justify-between">
                <p className="text-[13px] font-semibold">{p.name}</p>
                <p className="tnum text-[12px] text-ink-2">${p.priceMonthlyUsd}/mo</p>
              </div>
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-3">
                <li>{p.limits.postsPerMonth.toLocaleString()} posts / mo</li>
                <li>{(p.limits.aiTokensPerMonth / 1000).toLocaleString()}K AI tokens</li>
                <li>
                  {p.limits.connections} channels · {p.limits.seats} seat
                  {p.limits.seats === 1 ? "" : "s"}
                </li>
              </ul>
              {current ? (
                <p className="mt-2.5 text-[12px] font-medium text-accent-hover">Current plan</p>
              ) : p.code !== "FREE" && canManage ? (
                <Button
                  variant="secondary"
                  className="mt-2.5 h-8 w-full"
                  disabled={!data.stripeConfigured}
                  loading={checkout.isPending}
                  title={data.stripeConfigured ? "" : "Payments are not configured on this server yet"}
                  onClick={() => checkout.mutate(p.code)}
                >
                  {data.stripeConfigured ? `Upgrade to ${p.name}` : "Payments coming soon"}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-3">
        <ErrorNote message={error} />
      </div>
    </Card>
  );
}

function ApprovalCard() {
  const { organization, setRequireApproval } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const canManage = MANAGE_ROLES.includes(organization?.role ?? "");
  const enabled = organization?.requireApproval ?? false;

  const save = useMutation({
    mutationFn: (requireApproval: boolean) =>
      api<{ requireApproval: boolean }>("/members/org/settings", {
        method: "PATCH",
        body: { requireApproval },
      }),
    onSuccess: (res) => {
      setRequireApproval(res.requireApproval);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to save"),
  });

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Content approval</h2>
      <p className="mb-4 text-xs text-ink-3">
        When enabled, content (including autopilot drafts) must be approved by an admin or the
        owner before it can be scheduled or published.
      </p>
      <Switch
        checked={enabled}
        onChange={(v) => canManage && save.mutate(v)}
        label="Require approval before publishing"
        hint={canManage ? undefined : "Only admins or the owner can change this"}
      />
      <div className="mt-3">
        <ErrorNote message={error} />
      </div>
    </Card>
  );
}

function BrandKitCard() {
  const queryClient = useQueryClient();
  const { data: kit } = useQuery<BrandKit>({
    queryKey: ["brand-kit"],
    queryFn: () => api("/media/brand-kit"),
  });
  const [draft, setDraft] = useState<BrandKit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? kit;

  const save = useMutation({
    mutationFn: (body: BrandKit) =>
      api("/media/brand-kit", {
        method: "PUT",
        body: {
          primaryColor: body.primaryColor,
          secondaryColor: body.secondaryColor,
          fontFamily: body.fontFamily ?? "",
          watermarkEnabled: body.watermarkEnabled,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-kit"] });
      setDraft(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to save"),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      return api("/media/brand-kit/logo", {
        method: "POST",
        body: { filename: file.name, contentType: file.type, dataBase64 },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["brand-kit"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Logo upload failed"),
  });

  const uploadMusic = useMutation({
    mutationFn: async (file: File) => {
      // 15 MB decoded is the engine's limit; catching it here saves sending
      // twenty megabytes of base64 to be told no.
      if (file.size > 15_000_000) {
        throw new Error(`${file.name} is larger than 15 MB`);
      }
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      return api("/media/brand-kit/music", {
        method: "POST",
        body: { filename: file.name, contentType: file.type, dataBase64 },
      });
    },
    onMutate: () => setError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["brand-kit"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Track upload failed"),
  });

  const removeMusic = useMutation({
    mutationFn: () => api("/media/brand-kit/music", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["brand-kit"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Could not remove the track"),
  });

  if (!current) return null;
  const set = (patch: Partial<BrandKit>) => setDraft({ ...current, ...patch });

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Brand kit</h2>
      <p className="mb-4 text-xs text-ink-3">
        Used when the AI generates images — your logo and accent color are composited onto brand
        overlays.
      </p>

      <div className="mb-4 flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-3">
          {current.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current.logoUrl} alt="Logo" className="max-h-full max-w-full" />
          ) : (
            <span className="text-[12px] text-ink-3">No logo</span>
          )}
        </div>
        <label className="cursor-pointer">
          <span className="inline-flex items-center rounded-lg border border-line px-3 py-2 text-sm text-ink-2 hover:border-ink-3">
            {uploadLogo.isPending ? "Uploading…" : "Upload logo (PNG/JPEG)"}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadLogo.mutate(file);
            }}
          />
        </label>
      </div>

      {/* Background music for generated video. TikTok's own catalogue only
          works inside their app, so a directly published post carries whatever
          audio is baked into the file. */}
      <div className="mb-4 rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">Background music</p>
            <p className="mt-0.5 text-xs text-ink-3">
              Mixed quietly under the voiceover on generated video.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <span className="inline-flex items-center rounded-lg border border-line px-3 py-2 text-sm text-ink-2 hover:border-ink-3">
                {uploadMusic.isPending
                  ? "Uploading…"
                  : current.musicUrl
                    ? "Replace track"
                    : "Upload track (MP3/WAV)"}
              </span>
              <input
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/mp4,audio/aac,audio/ogg"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadMusic.mutate(file);
                  e.target.value = "";
                }}
              />
            </label>
            {current.musicUrl && (
              <button
                onClick={() => removeMusic.mutate()}
                disabled={removeMusic.isPending}
                className="rounded-lg border border-line px-3 py-2 text-sm text-ink-3 hover:border-ink-3 hover:text-ink disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {current.musicUrl ? (
          <div className="mt-3">
            <p className="mb-1.5 truncate font-mono text-[12px] text-ink-3">
              {current.musicName ?? "Track"}
            </p>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={current.musicUrl} className="h-9 w-full" />
          </div>
        ) : (
          /* Grey text mentioning only the voiceover let a workspace post to
             TikTok in silence without anything having warned it would. The
             brand kit is per workspace, so a track on one says nothing here. */
          <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3">
            <p className="text-xs font-medium text-ink-1">
              No track, so TikTok posts from this workspace go out silent.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">
              Photos are published as a slideshow carrying this track, and TikTok&rsquo;s
              own library is only reachable from inside their app. Generated video
              carries just the voiceover.
            </p>
          </div>
        )}

        {/* This warning was a paragraph of grey text and a commercial single got
            uploaded anyway, then muted by TikTok on arrival. The consequence is
            specific and worth stating as one. */}
        <div className="mt-3 flex gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/8 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-xs leading-relaxed text-ink-2">
            <p className="font-medium text-amber-600">Use music you are licensed to use.</p>
            <p className="mt-1">
              Commercial songs are detected on upload and the audio is silenced, so
              the post goes out with a track name attached and nothing playing. It
              can also cost the account a copyright strike. TikTok&rsquo;s own
              library does not help here either: that licence covers their editor,
              not files published through the API.
            </p>
            <p className="mt-1">
              Royalty-free sources that do work: Pixabay Music, Uppbeat, the YouTube
              Audio Library, or anything you made or bought a licence for.
            </p>
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <Label>Primary / accent color</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={current.primaryColor}
              onChange={(e) => set({ primaryColor: e.target.value.toUpperCase() })}
              className="h-9 w-12 cursor-pointer rounded border border-line bg-surface-2"
            />
            <Input
              value={current.primaryColor}
              onChange={(e) => set({ primaryColor: e.target.value.toUpperCase() })}
            />
          </div>
        </div>
        <div>
          <Label>Secondary color</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={current.secondaryColor}
              onChange={(e) => set({ secondaryColor: e.target.value.toUpperCase() })}
              className="h-9 w-12 cursor-pointer rounded border border-line bg-surface-2"
            />
            <Input
              value={current.secondaryColor}
              onChange={(e) => set({ secondaryColor: e.target.value.toUpperCase() })}
            />
          </div>
        </div>
      </div>

      <div className="mb-4">
        <Switch
          checked={current.watermarkEnabled}
          onChange={(v) => set({ watermarkEnabled: v })}
          label="Watermark generated images"
          hint="Overlay your logo on every AI-generated image by default."
        />
      </div>

      <ErrorNote message={error} />
      <Button
        onClick={() => save.mutate(current)}
        loading={save.isPending}
        disabled={!draft}
        className="mt-2"
      >
        Save brand kit
      </Button>
    </Card>
  );
}

export default function SettingsPage() {
  const { user, organization } = useAuthStore();
  const [mfaSetup, setMfaSetup] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaDone, setMfaDone] = useState(false);
  const [mfaOff, setMfaOff] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [mfaPassword, setMfaPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startMfa = async () => {
    setError(null);
    setBusy(true);
    try {
      setMfaSetup(await api("/auth/mfa/setup", { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "MFA setup failed");
    } finally {
      setBusy(false);
    }
  };

  const enableMfa = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("/auth/mfa/enable", { method: "POST", body: { code: mfaCode } });
      setMfaDone(true);
      setMfaSetup(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  const disableMfa = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("/auth/mfa/disable", {
        method: "POST",
        body: { password: mfaPassword, code: mfaCode },
      });
      // The session's cached user still says MFA is on; reflect it locally
      // rather than make someone sign out to see the change.
      setMfaDone(false);
      setMfaOff(true);
      setDisabling(false);
      setMfaPassword("");
      setMfaCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn off two-factor");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Account and workspace configuration." />

      <div className="space-y-4">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Account</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Name</Label>
              <Input value={user?.name ?? ""} disabled />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={user?.email ?? ""} disabled />
            </div>
            <div>
              <Label>Organization</Label>
              <Input value={organization?.name ?? ""} disabled />
            </div>
            <div>
              <Label>Role</Label>
              <Input value={organization?.role ?? ""} disabled />
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold">Two-factor authentication</h2>
          <p className="mb-4 text-xs text-ink-3">
            Protect your account with a TOTP authenticator app (Google Authenticator, 1Password,
            Authy…).
          </p>
          {(user?.mfaEnabled || mfaDone) && !mfaOff ? (
            <div className="space-y-3">
              <p className="text-sm text-emerald-500">✓ MFA is enabled on this account.</p>
              {disabling ? (
                <div className="space-y-2 rounded-lg border border-line p-3">
                  {/* Both factors, because either alone is a way in: a borrowed
                      unlocked laptop has the session but not the password, and a
                      leaked password has no authenticator. */}
                  <p className="text-xs text-ink-2">
                    Confirm with your password and a current code. Turning this off
                    means your password alone will get into this account.
                  </p>
                  <PasswordInput
                    value={mfaPassword}
                    onChange={(e) => setMfaPassword(e.target.value)}
                    placeholder="Your password"
                    autoComplete="current-password"
                  />
                  <Input
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="123456"
                    inputMode="numeric"
                    className="max-w-40"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      loading={busy}
                      disabled={mfaCode.length < 6 || mfaPassword.length < 1}
                      onClick={disableMfa}
                    >
                      Turn off two-factor
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDisabling(false);
                        setMfaPassword("");
                        setMfaCode("");
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setDisabling(true)}>
                  Turn off two-factor
                </Button>
              )}
            </div>
          ) : mfaOff ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">
                Two-factor is off. Your password alone now gets into this account.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setMfaOff(false);
                  void startMfa();
                }}
                loading={busy}
              >
                Set up MFA again
              </Button>
            </div>
          ) : mfaSetup ? (
            <div className="space-y-3">
              <p className="text-xs text-ink-2">
                Add this secret to your authenticator app, then enter the 6-digit code:
              </p>
              <code className="block break-all rounded-lg bg-surface-3 px-3 py-2 text-xs">
                {mfaSetup.secret}
              </code>
              <p className="break-all text-[14px] text-ink-3">{mfaSetup.otpauthUrl}</p>
              <div className="flex gap-2">
                <Input
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="123456"
                  className="max-w-40"
                />
                <Button onClick={enableMfa} loading={busy} disabled={mfaCode.length < 6}>
                  Verify & enable
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={startMfa} loading={busy}>
              Set up MFA
            </Button>
          )}
          <div className="mt-3">
            <ErrorNote message={error} />
          </div>
        </Card>

        <BillingCard />

        <ApprovalCard />

        <BrandKitCard />

        <Card>
          <h2 className="mb-1 text-sm font-semibold">Coming in the next phases</h2>
          <ul className="list-inside list-disc space-y-1 text-xs text-ink-3">
            <li>More platforms: TikTok, YouTube, Pinterest, Threads</li>
            <li>Deeper analytics: reach, engagement & follower growth</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
