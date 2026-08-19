"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertTriangle, CalendarClock, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PLATFORM_DEFAULT_PRESET } from "@godeye/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useToast } from "@/lib/toast";
import { GodeyeSpinner } from "@/components/logo";
import { ImageStudio } from "@/components/image-studio";
import { VideoStudio } from "@/components/video-studio";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  Switch,
  Textarea,
  cx,
} from "@/components/ui";

interface Connection {
  id: string;
  platform: string;
  status: string;
  displayName: string;
}

interface ContentItem {
  id: string;
  status: string;
  title: string | null;
  body: string;
  hashtags: string[];
  variants: Record<string, { body: string; hashtags: string[] }> | null;
  abVariants: Record<string, { body: string; hashtags: string[] }> | null;
  evergreen?: boolean;
  reviewNote?: string | null;
}

interface AgentRun {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  output: { contentItemId?: string } | null;
  error: string | null;
  costUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export default function ComposerPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { organization } = useAuthStore();
  const isReviewer = ["OWNER", "ADMIN"].includes(organization?.role ?? "");
  const [goal, setGoal] = useState("");
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("");
  const [cta, setCta] = useState("");
  const [selectedConnections, setSelectedConnections] = useState<string[]>([]);
  const [abTest, setAbTest] = useState(false);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [content, setContent] = useState<ContentItem | null>(null);
  const [mediaTab, setMediaTab] = useState<"image" | "video">("image");
  const [scheduledAt, setScheduledAt] = useState("");
  const [slideshowSeconds, setSlideshowSeconds] = useState<30 | 45 | 60>(30);
  const [renderAsVideo, setRenderAsVideo] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: connections = [] } = useQuery<Connection[]>({
    queryKey: ["connections"],
    queryFn: () => api("/connections"),
  });
  // A TikTok post with no track publishes silently. Nothing said so, not the
  // composer, not the result, and the brand kit is per workspace, so having
  // set a track on one says nothing about the one being posted from.
  const { data: brandKit } = useQuery<{ musicUrl: string | null }>({
    queryKey: ["brand-kit"],
    queryFn: () => api("/media/brand-kit"),
  });
  const activeConnections = connections.filter((c) => c.status === "ACTIVE");

  const selectedPlatforms = [
    ...new Set(
      activeConnections
        .filter((c) => selectedConnections.includes(c.id))
        .map((c) => c.platform),
    ),
  ];

  // A single destination is the common case, pre-select it so the user can
  // generate straight away instead of hunting for a click target.
  useEffect(() => {
    const active = connections.filter((c) => c.status === "ACTIVE");
    if (active.length === 1) {
      setSelectedConnections((sel) => (sel.length ? sel : [active[0].id]));
    }
  }, [connections]);

  // Poll the agent run while generating (the WS event invalidates queries too)
  const { data: run } = useQuery<AgentRun>({
    queryKey: ["agent-run", agentRunId],
    queryFn: () => api(`/content/agent-runs/${agentRunId}`),
    enabled: !!agentRunId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "SUCCEEDED" || status === "FAILED" ? false : 1500;
    },
  });

  useEffect(() => {
    if (!run) return;
    if (run.status === "SUCCEEDED" && run.output?.contentItemId && !content) {
      api<ContentItem>(`/content/${run.output.contentItemId}`).then(setContent);
    }
    if (run.status === "FAILED") {
      setError(run.error ?? "Generation failed");
      setAgentRunId(null);
    }
  }, [run, content]);

  const generateMutation = useMutation({
    mutationFn: () =>
      api<{ agentRunId: string }>("/content/generate", {
        method: "POST",
        body: {
          goal,
          platforms: selectedPlatforms,
          tone: tone || undefined,
          topic: topic || undefined,
          callToAction: cta || undefined,
          abTest,
        },
      }),
    onMutate: () => {
      setError(null);
      setContent(null);
      setScheduled(false);
    },
    onSuccess: (data) => setAgentRunId(data.agentRunId),
    onError: (e) => setError(e instanceof Error ? e.message : "Generation failed"),
  });

  const scheduleMutation = useMutation({
    mutationFn: () =>
      api("/schedule", {
        method: "POST",
        body: {
          contentItemId: content!.id,
          connectionIds: selectedConnections,
          scheduledAt: new Date(scheduledAt).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          slideshowSeconds,
          renderAsVideo,
        },
      }),
    onSuccess: () => {
      setScheduled(true);
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      // The inline confirmation sits at the bottom of a long form, below the
      // fold on a phone, so the screen looked unchanged and the post appeared
      // not to have been scheduled at all.
      const when = new Date(scheduledAt).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      });
      toast.success(
        `Scheduled to ${selectedConnections.length} destination${
          selectedConnections.length === 1 ? "" : "s"
        } for ${when}.`,
        { label: "View on Calendar", onClick: () => router.push("/calendar") },
      );
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "Scheduling failed");
      toast.error(e instanceof Error ? e.message : "Scheduling failed");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (action: "submit" | "approve" | "reject") =>
      api<ContentItem>(`/content/${content!.id}/${action}`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (updated) => {
      setContent(updated);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Review action failed"),
  });

  // Scheduling is blocked while the org requires approval and this item hasn't cleared review
  const approvalPending =
    (organization?.requireApproval ?? false) &&
    !!content &&
    !["APPROVED", "SCHEDULED", "PUBLISHED"].includes(content.status);

  const saveEdits = async (updated: ContentItem) => {
    setContent(updated);
    await api(`/content/${updated.id}`, {
      method: "PATCH",
      body: { body: updated.body, hashtags: updated.hashtags },
      // The edit is applied optimistically, so a swallowed failure leaves the
      // screen showing text the server never accepted. Logged rather than
      // discarded until there is somewhere to report it (error tracking, P2).
    }).catch((e: unknown) => console.error("Saving composer edits failed", e));
  };

  // Pick a winning A/B variant: it becomes the post, and the A/B split is turned off.
  const chooseVariant = async (v: { body: string; hashtags: string[] }) => {
    if (!content) return;
    setContent({ ...content, body: v.body, hashtags: v.hashtags, abVariants: null });
    await api(`/content/${content.id}`, {
      method: "PATCH",
      body: { body: v.body, hashtags: v.hashtags, abVariants: null },
    }).catch((e: unknown) => console.error("Choosing an A/B variant failed", e));
  };

  const generating =
    generateMutation.isPending || (!!agentRunId && run?.status !== "SUCCEEDED" && !content);

  const defaultSchedule = () => {
    const d = new Date(Date.now() + 5 * 60_000);
    d.setSeconds(0, 0);
    // datetime-local wants local time without seconds
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  useEffect(() => {
    if (!scheduledAt) setScheduledAt(defaultSchedule());
  }, [scheduledAt]);

  return (
    <>
      <PageHeader
        title="Composer"
        subtitle="Tell the Content Agent what you want to achieve. It writes for every platform at once."
      />

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Brief */}
        <Card className="space-y-4 lg:col-span-2">
          <div>
            <Label>Goal, what should this post achieve?</Label>
            <Textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Announce our new cold brew subscription and drive signups"
            />
          </div>
          <div>
            <Label>Topic (optional)</Label>
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Cold brew subscription launch" />
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="flex flex-col">
              <Label>Tone (optional)</Label>
              <Input
                className="mt-auto"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="Excited, friendly"
              />
            </div>
            <div className="flex flex-col">
              <Label>Call to action (optional)</Label>
              <Input
                className="mt-auto"
                value={cta}
                onChange={(e) => setCta(e.target.value)}
                placeholder="Link in bio"
              />
            </div>
          </div>

          <div>
            <Label>Publish to</Label>
            {activeConnections.length === 0 ? (
              <p className="text-xs text-ink-3">
                No active connections, add one on the Connections page first.
              </p>
            ) : (
              <div className="space-y-1.5">
                {activeConnections.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() =>
                      setSelectedConnections((s) =>
                        s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id],
                      )
                    }
                    className={cx(
                      "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      selectedConnections.includes(c.id)
                        ? "border-accent bg-accent-soft"
                        : "border-line hover:border-ink-3",
                    )}
                  >
                    <span className="truncate">{c.displayName}</span>
                    <span className="ml-2 shrink-0 text-[14px] text-ink-3">{c.platform}</span>
                  </button>
                ))}
              </div>
            )}

            {selectedPlatforms.includes("TIKTOK") && brandKit && !brandKit.musicUrl && (
              <div className="mt-3 flex gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/8 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="text-xs leading-relaxed text-ink-2">
                  <p className="font-medium text-amber-600">
                    This workspace has no track, so the TikTok post will be silent.
                  </p>
                  <p className="mt-1">
                    Photos are published as a slideshow carrying your background
                    track. Without one there is nothing to carry, and TikTok&rsquo;s
                    own music library is only reachable from inside their app.{" "}
                    <Link href="/settings" className="underline hover:text-ink">
                      Add a track in Settings
                    </Link>
                    .
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-line px-3 py-2.5">
            <Switch
              checked={abTest}
              onChange={setAbTest}
              label="A/B test this post"
              hint="Generate two competing angles; the engine splits them across your destinations and tracks which wins."
            />
          </div>

          <Button
            className="w-full"
            loading={generating}
            disabled={goal.trim().length < 3 || selectedConnections.length === 0}
            onClick={() => generateMutation.mutate()}
          >
            <Sparkles className="h-4 w-4" />
            {generating ? "Content Agent is writing…" : "Generate with AI"}
          </Button>
          {!generating && (goal.trim().length < 3 || selectedConnections.length === 0) && (
            <p className="text-center text-xs text-ink-3">
              {selectedConnections.length === 0
                ? activeConnections.length === 0
                  ? "Connect a destination on the Connections page to generate."
                  : "Select a destination under “Publish to” to enable generation."
                : "Add a goal (a few words) to enable generation."}
            </p>
          )}
          <ErrorNote message={error} />
        </Card>

        {/* Result */}
        <div className="lg:col-span-3">
          {!content && !generating && (
            <Card className="flex h-full min-h-64 flex-col items-center justify-center text-center">
              <Wand2 className="mb-3 h-8 w-8 text-ink-3" />
              <p className="text-sm font-medium text-ink-2">Your draft will appear here</p>
              <p className="mt-1 max-w-xs text-xs text-ink-3">
                The agent writes a canonical post plus a tailored variant per platform.
              </p>
            </Card>
          )}

          {generating && (
            <Card className="flex h-full min-h-64 flex-col items-center justify-center text-center">
              <GodeyeSpinner size={52} className="mb-3 text-accent" />
              <p className="text-sm font-medium">Writing on-brand content…</p>
              <p className="mt-1 text-xs text-ink-3">Usually takes 5-15 seconds</p>
            </Card>
          )}

          {content && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <Card className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{content.title ?? "Draft"}</p>
                  {run?.costUsd && (
                    <span className="text-[14px] text-ink-3">
                      {(run.inputTokens ?? 0) + (run.outputTokens ?? 0)} tokens · ${run.costUsd}
                    </span>
                  )}
                </div>

                <div>
                  <Label>Post text (editable)</Label>
                  <Textarea
                    rows={6}
                    value={content.body}
                    onChange={(e) => saveEdits({ ...content, body: e.target.value })}
                  />
                </div>

                <div>
                  <Label>Hashtags</Label>
                  <Input
                    value={content.hashtags.join(", ")}
                    onChange={(e) =>
                      saveEdits({
                        ...content,
                        hashtags: e.target.value.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean),
                      })
                    }
                  />
                </div>

                {content.abVariants && (
                  <div>
                    <Label>A/B variants, pick the one to use</Label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {Object.entries(content.abVariants).map(([key, v]) => (
                        <div
                          key={key}
                          className="flex flex-col rounded-lg border border-accent/40 bg-accent-soft/40 px-3 py-2"
                        >
                          <p className="mb-1 text-xs font-semibold text-accent">Variant {key}</p>
                          <p className="whitespace-pre-wrap text-sm">{v.body}</p>
                          {v.hashtags.length > 0 && (
                            <p className="mt-1 text-xs text-accent">
                              {v.hashtags.map((t) => `#${t}`).join(" ")}
                            </p>
                          )}
                          <Button
                            variant="secondary"
                            className="mt-2 w-full"
                            onClick={() => chooseVariant(v)}
                          >
                            Use variant {key}
                          </Button>
                        </div>
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-ink-3">
                      Picking one replaces the post above with that script and turns off the A/B
                      split, so it publishes as a single post.
                    </p>
                  </div>
                )}

                {content.variants && (
                  <div>
                    <Label>Platform variants</Label>
                    <div className="space-y-2">
                      {Object.entries(content.variants).map(([platform, v]) => (
                        <details key={platform} className="rounded-lg border border-line px-3 py-2">
                          <summary className="cursor-pointer text-xs font-medium text-ink-2">
                            {platform} · {v.body.length} chars
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap text-sm">{v.body}</p>
                          {v.hashtags.length > 0 && (
                            <p className="mt-1 text-xs text-accent">
                              {v.hashtags.map((t) => `#${t}`).join(" ")}
                            </p>
                          )}
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-t border-line pt-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Label>Add media (optional)</Label>
                    <div className="ml-auto flex rounded-lg border border-line p-0.5">
                      {(["image", "video"] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setMediaTab(tab)}
                          className={cx(
                            "rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors",
                            mediaTab === tab
                              ? "bg-accent text-white"
                              : "text-ink-2 hover:text-ink",
                          )}
                        >
                          {tab}
                        </button>
                      ))}
                    </div>
                  </div>
                  {mediaTab === "image" ? (
                    <ImageStudio
                      contentItemId={content.id}
                      defaultBrief={content.title ?? goal}
                      defaultPreset={
                        PLATFORM_DEFAULT_PRESET[selectedPlatforms[0] ?? ""] ?? "SQUARE"
                      }
                    />
                  ) : (
                    <VideoStudio contentItemId={content.id} defaultBrief={content.title ?? goal} />
                  )}
                </div>

                <div className="border-t border-line pt-4">
                  <div className="mb-3 rounded-lg border border-line px-3 py-2.5">
                    <Switch
                      checked={content.evergreen ?? false}
                      onChange={(v) => {
                        const updated = { ...content, evergreen: v };
                        setContent(updated);
                        api(`/content/${content.id}`, {
                          method: "PATCH",
                          body: { evergreen: v },
                        }).catch((e: unknown) =>
                          console.error("Saving the evergreen flag failed", e),
                        );
                      }}
                      label="Mark as evergreen"
                      hint="Autopilot plans with recycling can re-post this during quiet slots."
                    />
                  </div>
                  {approvalPending && (
                    <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-xs font-medium">
                            Approval required <Badge status={content.status} />
                          </p>
                          {content.status === "DRAFT" && content.reviewNote && (
                            <p className="mt-1 text-xs text-red-500">
                              Rejected: {content.reviewNote}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {content.status === "DRAFT" && (
                            <Button
                              variant="secondary"
                              loading={reviewMutation.isPending}
                              onClick={() => reviewMutation.mutate("submit")}
                            >
                              Submit for review
                            </Button>
                          )}
                          {content.status === "PENDING_APPROVAL" && isReviewer && (
                            <>
                              <Button
                                loading={reviewMutation.isPending}
                                onClick={() => reviewMutation.mutate("approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                variant="danger"
                                loading={reviewMutation.isPending}
                                onClick={() => reviewMutation.mutate("reject")}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {content.status === "PENDING_APPROVAL" && !isReviewer && (
                        <p className="mt-1 text-xs text-ink-3">
                          Waiting for an admin or the owner to approve this content.
                        </p>
                      )}
                    </div>
                  )}
                  <div className="mb-4 rounded-lg border border-line p-3">
                    <Label>Photo posts</Label>
                    <p className="mb-2.5 text-xs text-ink-3">
                      Photos become a video carrying your brand track, so the post
                      arrives with sound. They repeat in order to fill the length.
                    </p>
                    <div className="flex gap-2">
                      {([30, 45, 60] as const).map((seconds) => (
                        <button
                          key={seconds}
                          type="button"
                          onClick={() => setSlideshowSeconds(seconds)}
                          disabled={!renderAsVideo && !selectedPlatforms.includes("TIKTOK")}
                          className={cx(
                            "flex-1 rounded-lg border px-3 py-2 font-mono text-sm transition-colors",
                            "disabled:cursor-not-allowed disabled:opacity-40",
                            slideshowSeconds === seconds
                              ? "border-accent bg-accent-soft text-ink"
                              : "border-line text-ink-2 hover:border-ink-3",
                          )}
                        >
                          {seconds === 60 ? "1:00" : `0:${seconds}`}
                        </button>
                      ))}
                    </div>

                    {/* TikTok's API has no still post that can carry audio, so
                        there is nothing to choose there, offering the toggle
                        would only suggest an option that does not exist. */}
                    {selectedPlatforms.some((p) => p !== "TIKTOK") && (
                      <div className="mt-3">
                        <Switch
                          checked={renderAsVideo}
                          onChange={setRenderAsVideo}
                          label="Post as video"
                          hint={
                            selectedPlatforms.includes("TIKTOK")
                              ? "Applies to your other destinations, TikTok is always video. Off posts still photos there instead."
                              : "Off posts the photos as they are, with no sound."
                          }
                        />
                      </div>
                    )}
                  </div>

                  <Label>Publish time (your timezone)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      loading={scheduleMutation.isPending}
                      disabled={scheduled || !scheduledAt || approvalPending}
                      onClick={() => scheduleMutation.mutate()}
                    >
                      <CalendarClock className="h-4 w-4" />
                      {scheduled ? "Scheduled ✓" : "Schedule"}
                    </Button>
                  </div>
                  {scheduled && (
                    <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/8 p-3">
                      <p className="text-sm font-medium text-emerald-600">
                        Scheduled to {selectedConnections.length} destination
                        {selectedConnections.length === 1 ? "" : "s"}.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button variant="secondary" onClick={() => router.push("/calendar")}>
                          <CalendarClock className="h-3.5 w-3.5" /> View on Calendar
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            // Clear the form for the next post rather than leave
                            // a finished one sitting there looking editable.
                            setContent(null);
                            setAgentRunId(null);
                            setScheduled(false);
                            setGoal("");
                            setTopic("");
                            setError(null);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          Write another
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </motion.div>
          )}
        </div>
      </div>
    </>
  );
}
