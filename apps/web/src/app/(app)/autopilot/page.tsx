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
  PageHeader,
  Switch,
  cx,
} from "@/components/ui";

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
        subtitle="Hands-off posting. GODEYE writes, schedules, and publishes on your cadence — optimizing times and testing angles automatically."
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
          {plans.map((plan) => (
            <Card key={plan.id} className="!p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">{plan.name}</p>
                    <Badge status={plan.active ? "ACTIVE" : "DISCONNECTED"} />
                    {plan.autoGenerate && (
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                        Autopilot
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-ink-3">
                    {CADENCE_LABEL[plan.cadence] ?? plan.cadence} ·{" "}
                    {plan.platforms.map((p) => PLATFORM_INFO[p as Platform]?.label ?? p).join(", ")}
                    {plan.preferredTimes.length > 0
                      ? ` · ${plan.preferredTimes.join(", ")}`
                      : " · best-time detection"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {plan.abTesting && (
                      <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2">
                        A/B testing
                      </span>
                    )}
                    {plan.recycleEvergreen && (
                      <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2">
                        Evergreen recycling
                      </span>
                    )}
                    {plan.generateImages && (
                      <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2">
                        AI images
                      </span>
                    )}
                    {plan.topics.slice(0, 3).map((t) => (
                      <span key={t} className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2">
                        {t}
                      </span>
                    ))}
                    {plan.topics.length > 3 && (
                      <span className="text-[11px] text-ink-3">+{plan.topics.length - 3} more</span>
                    )}
                  </div>
                </div>
                <Switch
                  checked={plan.active}
                  onChange={(active) => toggleMutation.mutate({ id: plan.id, active })}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
