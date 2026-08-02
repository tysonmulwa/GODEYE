"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Pencil, Plus, Rocket, X } from "lucide-react";
import { useState } from "react";
import { PLATFORM_INFO, AVAILABLE_PLATFORMS, type Platform } from "@godeye/shared";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
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
  slideshowSeconds: 30 | 45 | 60;
  renderAsVideo: boolean;
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

// Mirrors CADENCE_TIMES_PER_DAY in tasks/planner.py: a DAILY_2 plan uses the two
// earliest times, so listing five and expecting five posts is a surprise worth
// heading off before it happens.
const TIMES_PER_DAY: Record<string, number> = { DAILY_1: 1, DAILY_2: 2, DAILY_3: 3, WEEKENDS: 1 };
const cadenceUsesTimes = (cadence: string) => cadence in TIMES_PER_DAY;
const timesUsedByCadence = (cadence: string) => TIMES_PER_DAY[cadence] ?? 1;

export default function AutopilotPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Null while creating; a plan id while editing that plan.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newTime, setNewTime] = useState("");
  const emptyForm = {
    name: "",
    cadence: "DAILY_1",
    platforms: [] as Platform[],
    // A list, not a comma-separated string. Typing "9am, 5.30" into a text box
    // and having it silently rejected by a regex is not a way to set a time.
    preferredTimes: [] as string[],
    topics: "",
    autoGenerate: true,
    abTesting: false,
    recycleEvergreen: false,
    generateImages: false,
    slideshowSeconds: 30,
    renderAsVideo: true,
  };
  const [form, setForm] = useState(emptyForm);

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

  // Why Launch is unavailable, in the order someone hits them. Null means go.
  const blockedReason =
    connectedPlatforms.size === 0
      ? "Connect at least one account first — Autopilot publishes to your connected channels, and there are none yet."
      : form.name.trim().length < 1
        ? "Give the plan a name."
        : form.platforms.length === 0
          ? "Pick at least one platform to publish to."
          : null;

  const planBody = () => ({
    name: form.name,
    cadence: form.cadence,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platforms: form.platforms,
    preferredTimes: [...form.preferredTimes].sort(),
    topics: form.topics
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean),
    autoGenerate: form.autoGenerate,
    abTesting: form.abTesting,
    recycleEvergreen: form.recycleEvergreen,
    generateImages: form.generateImages,
  });

  const closeForm = () => {
    queryClient.invalidateQueries({ queryKey: ["posting-plans"] });
    setCreating(false);
    setEditingId(null);
    setError(null);
    setForm(emptyForm);
  };

  const createMutation = useMutation({
    mutationFn: () => api("/posting-plans", { method: "POST", body: planBody() }),
    onSuccess: () => {
      closeForm();
      toast.success("Autopilot plan launched. The first slots are booked within 5 minutes.");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to create plan"),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      api<{ cancelledUpcoming?: number }>(`/posting-plans/${editingId}`, {
        method: "PATCH",
        body: planBody(),
      }),
    onSuccess: (data) => {
      closeForm();
      // Changing the times cancels slots already booked at the old ones, and
      // that is worth saying rather than leaving someone to notice later.
      toast.success(
        data?.cancelledUpcoming
          ? `Plan updated. ${data.cancelledUpcoming} upcoming post(s) rescheduled to the new times.`
          : "Plan updated.",
      );
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to update plan"),
  });

  const startEdit = (plan: PostingPlan) => {
    setForm({
      name: plan.name,
      cadence: plan.cadence,
      platforms: plan.platforms as Platform[],
      preferredTimes: plan.preferredTimes ?? [],
      topics: (plan.topics ?? []).join("\n"),
      autoGenerate: plan.autoGenerate,
      abTesting: plan.abTesting,
      recycleEvergreen: plan.recycleEvergreen,
      generateImages: plan.generateImages,
      slideshowSeconds: plan.slideshowSeconds,
      renderAsVideo: plan.renderAsVideo,
    });
    setEditingId(plan.id);
    setCreating(true);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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
          <Button onClick={() => (creating ? closeForm() : setCreating(true))}>
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
              <Label>Publish times (leave empty to let GODEYE pick the best times)</Label>
              <div className="flex flex-wrap items-center gap-2">
                {[...form.preferredTimes].sort().map((time) => (
                  <span
                    key={time}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-soft py-1 pl-3 pr-1.5 text-xs text-accent"
                  >
                    <span className="tnum font-mono">{time}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${time}`}
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          preferredTimes: f.preferredTimes.filter((t) => t !== time),
                        }))
                      }
                      className="rounded-full p-0.5 hover:bg-accent/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {/* A native time input: the OS gives a phone its own clock
                    picker, and there is no format to get wrong. */}
                <input
                  type="time"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                />
                <Button
                  variant="secondary"
                  disabled={!newTime || form.preferredTimes.includes(newTime)}
                  onClick={() => {
                    setForm((f) => ({
                      ...f,
                      preferredTimes: [...f.preferredTimes, newTime].sort(),
                    }));
                    setNewTime("");
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Add time
                </Button>
              </div>
              {form.preferredTimes.length > 0 && (
                <p className="mt-1.5 text-xs text-ink-3">
                  {cadenceUsesTimes(form.cadence)
                    ? `This cadence publishes ${timesUsedByCadence(form.cadence)} a day, so the ${
                        timesUsedByCadence(form.cadence)
                      } earliest of these are used.`
                    : "This cadence sets its own times; these are ignored."}
                </p>
              )}
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

            <div className="mt-4 rounded-lg border border-line p-3">
              <Label>Photo posts</Label>
              <p className="mb-2.5 text-xs text-ink-3">
                Nobody sees these before they publish, so the length is chosen here
                and every post this plan generates inherits it.
              </p>
              <div className="flex gap-2">
                {([30, 45, 60] as const).map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, slideshowSeconds: seconds }))}
                    className={cx(
                      "flex-1 rounded-lg border px-3 py-2 font-mono text-sm transition-colors",
                      form.slideshowSeconds === seconds
                        ? "border-accent bg-accent-soft text-ink-1"
                        : "border-line text-ink-2 hover:border-ink-3",
                    )}
                  >
                    {seconds === 60 ? "1:00" : `0:${seconds}`}
                  </button>
                ))}
              </div>
              {/* TikTok's API has no still post that can carry audio, so there
                  is nothing to choose there. */}
              {form.platforms.some((p) => p !== "TIKTOK") && (
                <div className="mt-3">
                  <Switch
                    checked={form.renderAsVideo}
                    onChange={(v) => setForm((f) => ({ ...f, renderAsVideo: v }))}
                    label="Post as video"
                    hint={
                      form.platforms.includes("TIKTOK")
                        ? "Applies to your other destinations — TikTok is always video."
                        : "Off posts the photos as they are, with no sound."
                    }
                  />
                </div>
              )}
            </div>

            <ErrorNote message={error} />
            {/* A disabled button that says nothing is indistinguishable from a
                broken one. No plan had ever been created, and this is why:
                pressing Launch without a platform selected did nothing at all
                and offered no reason. */}
            {blockedReason && (
              <p className="rounded-lg border border-line bg-surface-3 px-3 py-2 text-xs text-ink-2">
                {blockedReason}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                loading={createMutation.isPending || updateMutation.isPending}
                disabled={!!blockedReason}
                onClick={() => (editingId ? updateMutation.mutate() : createMutation.mutate())}
              >
                <Rocket className="h-4 w-4" />
                {editingId ? "Save changes" : "Launch plan"}
              </Button>
              {editingId && (
                <Button variant="ghost" onClick={closeForm}>
                  Cancel
                </Button>
              )}
            </div>
            {editingId && (
              <p className="text-xs text-ink-3">
                Changing the times, cadence or channels cancels posts already booked at
                the old settings and re-plans them. Anything already published stays.
              </p>
            )}
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
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={() => startEdit(plan)} title="Edit this plan">
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Switch
                      checked={plan.active}
                      onChange={(active) => toggleMutation.mutate({ id: plan.id, active })}
                    />
                  </div>
                </div>
                <p className="mt-2 font-mono text-[14px] text-ink-3">
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
                      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[14px] text-ink-2"
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
                    <span className="font-mono text-[14px] text-ink-4">
                      +{plan.topics.length - 4}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between font-mono text-[12px] uppercase tracking-[0.06em] text-ink-4">
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
