"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Plus, Rocket } from "lucide-react";
import { useState } from "react";
import { PLATFORM_INFO, AVAILABLE_PLATFORMS, type Platform } from "@godeye/shared";
import { api } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  LiveDot,
  MonoChip,
  PageHeader,
  Switch,
  cx,
} from "@/components/ui";

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

interface Connection {
  id: string;
  platform: string;
  status: string;
}

interface PostingPlan {
  id: string;
  name: string;
  cadence: string;
  timezone: string;
  platforms: string[];
  preferredTimes: string[];
  active: boolean;
  autoGenerate: boolean;
  topics: string[];
  abTesting: boolean;
  recycleEvergreen: boolean;
  generateImages: boolean;
  lastPlannedAt: string | null;
}

const CADENCES = [
  { value: "DAILY_1", label: "1× / day" },
  { value: "DAILY_2", label: "2× / day" },
  { value: "DAILY_3", label: "3× / day" },
  { value: "HOURLY", label: "Every hour" },
  { value: "WEEKENDS", label: "Weekends only" },
];

const CADENCE_LABEL: Record<string, string> = Object.fromEntries(
  CADENCES.map((c) => [c.value, c.label]),
);

export default function AutopilotPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    cadence: "DAILY_1",
    platforms: [] as Platform[],
    preferredTimes: "",
    topics: "",
    autoGenerate: true,
    abTesting: false,
    recycleEvergreen: false,
    generateImages: false,
  });

  const { data: plans = [], isLoading } = useQuery<PostingPlan[]>({
    queryKey: ["posting-plans"],
    queryFn: () => api("/posting-plans"),
  });
  const { data: connections = [] } = useQuery<Connection[]>({
    queryKey: ["connections"],
    queryFn: () => api("/connections"),
  });
  const connectedPlatforms = new Set(
    connections.filter((c) => c.status === "ACTIVE").map((c) => c.platform),
  );

  const createMutation = useMutation({
    mutationFn: () =>
      api("/posting-plans", {
        method: "POST",
        body: {
          name: form.name,
          cadence: form.cadence,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platforms: form.platforms,
          preferredTimes: form.preferredTimes
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          topics: form.topics
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean),
          autoGenerate: form.autoGenerate,
          abTesting: form.abTesting,
          recycleEvergreen: form.recycleEvergreen,
          generateImages: form.generateImages,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posting-plans"] });
      setCreating(false);
      setError(null);
      setForm({
        name: "",
        cadence: "DAILY_1",
        platforms: [],
        preferredTimes: "",
        topics: "",
        autoGenerate: true,
        abTesting: false,
        recycleEvergreen: false,
        generateImages: false,
      });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to create plan"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api(`/posting-plans/${id}`, { method: "PATCH", body: { active } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posting-plans"] }),
  });

  const togglePlatform = (p: Platform) =>
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(p)
        ? f.platforms.filter((x) => x !== p)
        : [...f.platforms, p],
    }));

  return (
    <>
      <PageHeader
        title="Autopilot"
        subtitle={
          <>
            <LiveDot pulse={plans.some((p) => p.active)} />
            <span>
              {plans.filter((p) => p.active).length} running ·{" "}
              {plans.filter((p) => !p.active).length} paused
            </span>
          </>
        }
        actions={
          <Button onClick={() => setCreating((v) => !v)}>
            <Plus className="h-4 w-4" /> {creating ? "Close" : "New plan"}
          </Button>
        }
      />

      {creating && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
          <Card className="mb-6 space-y-4">
            <div>
              <Label>Plan name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Always-on brand presence"
              />
            </div>

            <div>
              <Label>Cadence</Label>
              <div className="flex flex-wrap gap-2">
                {CADENCES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, cadence: c.value }))}
                    className={cx(
                      "rounded-full border px-3 py-1.5 text-xs transition-colors",
                      form.cadence === c.value
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-line text-ink-2 hover:border-ink-3",
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Platforms</Label>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_PLATFORMS.map((p) => {
                  const connected = connectedPlatforms.has(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      disabled={!connected}
                      onClick={() => togglePlatform(p)}
                      title={connected ? "" : "Connect this platform first"}
                      className={cx(
                        "rounded-full border px-3 py-1.5 text-xs transition-colors",
                        form.platforms.includes(p)
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-line text-ink-2 hover:border-ink-3",
                        !connected && "cursor-not-allowed opacity-40",
                      )}
                    >
                      {PLATFORM_INFO[p].label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>Preferred times (optional, comma-separated — blank = best-time detection)</Label>
              <Input
                value={form.preferredTimes}
                onChange={(e) => setForm((f) => ({ ...f, preferredTimes: e.target.value }))}
                placeholder="09:00, 17:30"
              />
            </div>

            <div>
              <Label>Content topics (one per line — the AI rotates through these)</Label>
              <textarea
                rows={3}
                value={form.topics}
                onChange={(e) => setForm((f) => ({ ...f, topics: e.target.value }))}
                placeholder={"New arrivals\nBehind the scenes\nCustomer stories\nTips & how-tos"}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div className="space-y-3 rounded-lg border border-line p-3">
              <Switch
                checked={form.autoGenerate}
                onChange={(v) => setForm((f) => ({ ...f, autoGenerate: v }))}
                label="Auto-generate & publish"
                hint="The engine writes new content for each slot automatically. Off = the plan is a schedule template only."
              />
              <Switch
                checked={form.abTesting}
                onChange={(v) => setForm((f) => ({ ...f, abTesting: v }))}
                label="A/B test every post"
                hint="Generate two angles per post and split them across destinations."
              />
              <Switch
                checked={form.recycleEvergreen}
                onChange={(v) => setForm((f) => ({ ...f, recycleEvergreen: v }))}
                label="Recycle evergreen content"
                hint="Re-post your best evergreen pieces during quiet slots."
              />
              <Switch
                checked={form.generateImages}
                onChange={(v) => setForm((f) => ({ ...f, generateImages: v }))}
                label="Generate an image per post"
                hint="The Image Agent creates an on-brand image for every autopilot post."
              />
            </div>

            <ErrorNote message={error} />
            <Button
              className="w-full"
              loading={createMutation.isPending}
              disabled={form.name.trim().length < 1 || form.platforms.length === 0}
              onClick={() => createMutation.mutate()}
            >
              <Rocket className="h-4 w-4" /> Launch plan
            </Button>
          </Card>
        </motion.div>
      )}

      {isLoading ? null : plans.length === 0 ? (
        <EmptyState
          title="No autopilot plans yet"
          hint="Create a plan and GODEYE will keep your channels active without you lifting a finger."
        />
      ) : (
        <div className="space-y-3">
          {plans.map((plan) => {
            const features = [
              plan.autoGenerate && "auto-generate",
              plan.abTesting && "a/b testing",
              plan.recycleEvergreen && "evergreen",
              plan.generateImages && "ai images",
            ].filter(Boolean) as string[];
            return (
              <Card key={plan.id} className={cx("!p-4", !plan.active && "opacity-70")}>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <MonoChip>{kebab(plan.name)}</MonoChip>
                    <Badge status={plan.active ? "ACTIVE" : "PAUSED"} />
                  </div>
                  <Switch
                    checked={plan.active}
                    onChange={(active) => toggleMutation.mutate({ id: plan.id, active })}
                  />
                </div>
                <p className="mt-2 font-mono text-[11px] text-ink-3">
                  {(CADENCE_LABEL[plan.cadence] ?? plan.cadence).toLowerCase().replace(/ /g, "")}
                  {" · "}
                  {plan.platforms.length} channel{plan.platforms.length === 1 ? "" : "s"}
                  {" · "}
                  {plan.preferredTimes.length > 0 ? plan.preferredTimes.join(" · ") : "best-time"}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
                  {features.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2"
                    >
                      <span className="h-1 w-1 rounded-full bg-accent" /> {f}
                    </span>
                  ))}
                  {plan.topics.slice(0, 4).map((t) => (
                    <MonoChip key={t} tone="faint">
                      {t}
                    </MonoChip>
                  ))}
                  {plan.topics.length > 4 && (
                    <span className="font-mono text-[11px] text-ink-4">
                      +{plan.topics.length - 4}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-4">
                  <span>
                    {plan.active
                      ? plan.lastPlannedAt
                        ? `last planned ${new Date(plan.lastPlannedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                        : "waiting for first run"
                      : "status paused"}
                  </span>
                  <span>
                    {plan.platforms
                      .map((p) => PLATFORM_INFO[p as Platform]?.label ?? p)
                      .join(" · ")}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
