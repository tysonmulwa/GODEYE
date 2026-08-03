"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  PasswordInput,
  PlatformGlyph,
} from "@/components/ui";

interface Connection {
  id: string;
  platform: string;
  status: string;
  displayName: string;
  lastError: string | null;
  createdAt: string;
}

type FormKind = "telegram" | "discord" | "x" | null;

function ConnectionsInner() {
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<FormKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const { data: connections = [], isLoading } = useQuery<Connection[]>({
    queryKey: ["connections"],
    queryFn: () => api("/connections"),
  });

  const connectMutation = useMutation({
    mutationFn: async ({ kind, body }: { kind: string; body: Record<string, string> }) =>
      api(`/connections/${kind}`, { method: "POST", body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      setOpenForm(null);
      setFields({});
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Connection failed"),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  const connectMeta = async () => {
    try {
      const { url } = await api<{ url: string }>("/connections/meta/authorize");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Meta authorization failed");
    }
  };

  const connectLinkedin = async () => {
    try {
      const { url } = await api<{ url: string }>("/connections/linkedin/authorize");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "LinkedIn authorization failed");
    }
  };

  const connectTiktok = async () => {
    try {
      const { url } = await api<{ url: string }>("/connections/tiktok/authorize");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "TikTok authorization failed");
    }
  };

  const connectInstagram = async () => {
    try {
      const { url } = await api<{ url: string }>("/connections/instagram/authorize");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Instagram authorization failed");
    }
  };

  const connectReddit = async () => {
    try {
      const { url } = await api<{ url: string }>("/connections/reddit/authorize");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reddit authorization failed");
    }
  };

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const forms: Record<Exclude<FormKind, null>, { fields: { key: string; label: string; placeholder: string; type?: string }[]; hint: string }> = {
    telegram: {
      hint: "Create a bot with @BotFather, add it to your channel as admin, then paste the token and channel handle.",
      fields: [
        { key: "botToken", label: "Bot token", placeholder: "123456789:AAF...", type: "password" },
        { key: "chatId", label: "Channel / chat", placeholder: "@mychannel or -100123456789" },
      ],
    },
    discord: {
      hint: "Create an application at discord.com/developers, add a bot, invite it to your server with Send Messages permission.",
      fields: [
        { key: "botToken", label: "Bot token", placeholder: "MTAx...", type: "password" },
        { key: "channelId", label: "Channel ID", placeholder: "Enable developer mode → right-click channel → Copy ID" },
      ],
    },
    x: {
      hint: "Generate an Access Token and Secret with Read and Write permission for the account you want to post from. The app keys are held by GODEYE.",
      fields: [
        { key: "accessToken", label: "Access token", placeholder: "Access Token", type: "password" },
        { key: "accessSecret", label: "Access secret", placeholder: "Access Token Secret", type: "password" },
      ],
    },
  };

  const providers = [
    { kind: "telegram" as const, name: "Telegram", glyph: "TELEGRAM", desc: "Post to channels & groups" },
    { kind: "discord" as const, name: "Discord", glyph: "DISCORD", desc: "Post to server channels" },
    { kind: "x" as const, name: "X (Twitter)", glyph: "X", desc: "Publish tweets" },
  ];

  const counts = {
    active: connections.filter((c) => c.status === "ACTIVE").length,
    expired: connections.filter((c) => c.status === "EXPIRED").length,
    error: connections.filter((c) => c.status === "ERROR").length,
  };

  return (
    <>
      <PageHeader
        title="Connections"
        subtitle={
          <span>
            <span className="text-emerald-600">{counts.active} active</span>
            {counts.expired > 0 && <span className="text-amber-600"> · {counts.expired} expired</span>}
            {counts.error > 0 && <span className="text-red-600"> · {counts.error} error</span>}
            <span> · credentials encrypted at rest</span>
          </span>
        }
      />

      {params.get("connected") && (
        <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
          {{ meta: "Meta", linkedin: "LinkedIn", reddit: "Reddit", instagram: "Instagram", tiktok: "TikTok" }[
            params.get("connected") as string
          ] ?? "Account"}{" "}
          connected, {params.get("count")} account(s) added.
        </p>
      )}
      {params.get("error") && <ErrorNote message={params.get("error")} />}
      {/* The OAuth buttons set `error` but the only other ErrorNotes live inside
          the collapsible credential forms, so a failure there showed nothing at
          all and the button looked dead. */}
      {!openForm && <ErrorNote message={error} />}

      {/* Connected accounts */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-ink-2">Connected accounts</h2>
        {isLoading ? null : connections.length === 0 ? (
          <EmptyState
            title="Nothing connected yet"
            hint="Connect at least one platform below so the AI has somewhere to publish."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connections.map((c) => (
              <Card key={c.id} className="!p-4">
                <div className="flex items-center gap-3">
                  <PlatformGlyph platform={c.platform} size={36} className="!rounded-[9px]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold">
                      {c.platform.charAt(0) + c.platform.slice(1).toLowerCase()}
                    </p>
                    <p className="truncate font-mono text-[12px] text-ink-3">{c.displayName}</p>
                  </div>
                  <Badge status={c.status} />
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-line-soft pt-2.5">
                  <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-ink-4">
                    since{" "}
                    {new Date(c.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <button
                    onClick={() => removeMutation.mutate(c.id)}
                    aria-label="Disconnect"
                    className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {c.lastError && (
                  <p className="mt-2 truncate font-mono text-[12px] text-red-500">{c.lastError}</p>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Add new */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-ink-2">Add a platform</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {providers.map(({ kind, name, glyph, desc }) => (
            <Card key={kind} className="!p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <PlatformGlyph platform={glyph} size={36} className="!rounded-[9px]" />
                  <div>
                    <p className="text-sm font-medium">{name}</p>
                    <p className="text-xs text-ink-3">{desc}</p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpenForm(openForm === kind ? null : kind);
                    setFields({});
                    setError(null);
                  }}
                >
                  {openForm === kind ? "Close" : "Connect"}
                </Button>
              </div>

              {openForm === kind && (
                <motion.form
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="mt-4 space-y-3 overflow-hidden border-t border-line pt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    connectMutation.mutate({ kind, body: fields });
                  }}
                >
                  <p className="text-xs text-ink-3">{forms[kind].hint}</p>
                  {forms[kind].fields.map((f) => (
                    <div key={f.key}>
                      <Label>{f.label}</Label>
                      {f.type === "password" ? (
                        <PasswordInput
                          required
                          value={fields[f.key] ?? ""}
                          onChange={set(f.key)}
                          placeholder={f.placeholder}
                        />
                      ) : (
                        <Input
                          required
                          value={fields[f.key] ?? ""}
                          onChange={set(f.key)}
                          placeholder={f.placeholder}
                        />
                      )}
                    </div>
                  ))}
                  <ErrorNote message={error} />
                  <Button type="submit" loading={connectMutation.isPending} className="w-full">
                    Validate & connect
                  </Button>
                </motion.form>
              )}
            </Card>
          ))}

          <Card className="!p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <PlatformGlyph platform="REDDIT" size={36} className="!rounded-[9px]" />
                <div>
                  <p className="text-sm font-medium">Reddit</p>
                  <p className="text-xs text-ink-3">One click, sign in and authorize</p>
                </div>
              </div>
              <Button variant="secondary" onClick={connectReddit}>
                Connect
              </Button>
            </div>
          </Card>

          <Card className="!p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <PlatformGlyph platform="FACEBOOK" size={36} className="!rounded-[9px]" />
                <div>
                  <p className="text-sm font-medium">Facebook Pages</p>
                  <p className="text-xs text-ink-3">
                    Sign in and pick your Page. Instagram connects separately, below.
                  </p>
                </div>
              </div>
              <Button variant="secondary" onClick={connectMeta}>
                Connect
              </Button>
            </div>
          </Card>

          <Card className="!p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <PlatformGlyph platform="INSTAGRAM" size={36} className="!rounded-[9px]" />
                <div>
                  <p className="text-sm font-medium">Instagram</p>
                  <p className="text-xs text-ink-3">
                    Business/Creator, works with or without a Facebook Page
                  </p>
                </div>
              </div>
              <Button variant="secondary" onClick={connectInstagram}>
                Connect
              </Button>
            </div>
            {/* Instagram's own OAuth is unreliable inside mobile in-app
                browsers, the redirect gets mishandled and it fails with a
                generic "something went wrong". Say so up front rather than
                leave people retrying. */}
            <p className="mt-2 border-t border-line pt-2 text-xs text-ink-3 lg:hidden">
              On a phone Instagram often fails with “something went wrong”. Connect from a
              desktop browser, or open this page in Chrome/Safari rather than an app’s
              built-in browser.
            </p>
          </Card>

          <Card className="!p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <PlatformGlyph platform="TIKTOK" size={36} className="!rounded-[9px]" />
                <div>
                  <p className="text-sm font-medium">TikTok</p>
                  <p className="text-xs text-ink-3">Video posts, attach a video</p>
                </div>
              </div>
              <Button variant="secondary" onClick={connectTiktok}>
                Connect
              </Button>
            </div>
          </Card>

          <Card className="!p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <PlatformGlyph platform="LINKEDIN" size={36} className="!rounded-[9px]" />
                <div>
                  <p className="text-sm font-medium">LinkedIn</p>
                  <p className="text-xs text-ink-3">OAuth, post to your profile feed</p>
                </div>
              </div>
              <Button variant="secondary" onClick={connectLinkedin}>
                Connect
              </Button>
            </div>
          </Card>

          <div className="flex items-center justify-center rounded-[11px] border border-dashed border-line p-4">
            <p className="font-mono text-[14px] text-ink-3">
              soon · YouTube · Pinterest · Threads
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

export default function ConnectionsPage() {
  return (
    <Suspense>
      <ConnectionsInner />
    </Suspense>
  );
}
