"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button, Card, ErrorNote, Input, Label, PageHeader, Switch } from "@/components/ui";

interface BrandKit {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  fontFamily: string | null;
  watermarkEnabled: boolean;
}

const MANAGE_ROLES = ["OWNER", "ADMIN"];

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
          {user?.mfaEnabled || mfaDone ? (
            <p className="text-sm text-emerald-500">✓ MFA is enabled on this account.</p>
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

        <ApprovalCard />

        <BrandKitCard />

        <Card>
          <h2 className="mb-1 text-sm font-semibold">Coming in the next phases</h2>
          <ul className="list-inside list-disc space-y-1 text-xs text-ink-3">
            <li>Billing & subscription management</li>
            <li>More platforms: TikTok, YouTube, Pinterest, Threads</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
