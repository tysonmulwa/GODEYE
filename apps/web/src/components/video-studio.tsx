"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { LiveStatus } from "@/components/live-status";
import { motion } from "framer-motion";
import { Clapperboard, Film, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TTS_VOICES, VIDEO_DURATIONS, VIDEO_PRESETS, VIDEO_PRESET_IDS } from "@godeye/shared";
import { api } from "@/lib/api";
import { useEasedProgress } from "@/lib/use-eased-progress";

// base64 in a JSON body inflates ~33%, against the API's 30 MB limit.
const MAX_VIDEO_BYTES = 20_000_000;
import { Button, ErrorNote, Input, Label, Switch, cx } from "@/components/ui";

interface AgentRun {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  output: {
    url?: string;
    mediaAssetId?: string;
    title?: string;
    durationSec?: number;
    progress?: string;
    detail?: string;
    // Stage percentage from the engine; see STAGE_PERCENT in tasks/video.py.
    percent?: number;
  } | null;
  error: string | null;
  costUsd: string | null;
}

const STEP_LABELS: Record<string, string> = {
  script: "Writing the script",
  scenes: "Generating scene visuals & voiceover",
  assembly: "Cutting scenes together",
  captions: "Burning subtitles",
  upload: "Uploading",
};
const STEP_ORDER = ["script", "scenes", "assembly", "captions", "upload"];

/** Short-video generation: brief → script → scenes → voiceover → captions → mp4. */
export function VideoStudio({
  contentItemId,
  defaultBrief,
}: {
  contentItemId?: string;
  defaultBrief?: string;
}) {
  const [brief, setBrief] = useState(defaultBrief ?? "");
  const [preset, setPreset] = useState("VERTICAL");
  const [durationSec, setDurationSec] = useState<number>(30);
  const [voice, setVoice] = useState("nova");
  const [includeCaptions, setIncludeCaptions] = useState(true);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<{ title?: string; durationSec?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultBrief && !brief) setBrief(defaultBrief);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultBrief]);

  const { data: run } = useQuery<AgentRun>({
    queryKey: ["agent-run", agentRunId],
    queryFn: () => api(`/content/agent-runs/${agentRunId}`),
    enabled: !!agentRunId,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "SUCCEEDED" || s === "FAILED" ? false : 2000;
    },
  });

  useEffect(() => {
    if (!run) return;
    if (run.status === "SUCCEEDED" && run.output?.url) {
      setVideoUrl(run.output.url);
      setVideoMeta({ title: run.output.title, durationSec: run.output.durationSec });
      setAgentRunId(null);
    }
    if (run.status === "FAILED") {
      setError(run.error ?? "Video generation failed");
      setAgentRunId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const generate = useMutation({
    mutationFn: () =>
      api<{ agentRunId: string }>("/media/generate-video", {
        method: "POST",
        body: { brief, preset, durationSec, voice, includeCaptions, contentItemId },
      }),
    onMutate: () => {
      setError(null);
      setVideoUrl(null);
      setVideoMeta(null);
    },
    onSuccess: (data) => setAgentRunId(data.agentRunId),
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to start video generation"),
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read the video"));
        reader.readAsDataURL(file);
      });
      return api<{ url: string }>("/media/upload", {
        method: "POST",
        body: { contentItemId, contentType: file.type, dataBase64, filename: file.name },
      });
    },
    onMutate: () => setError(null),
    onSuccess: (data) => setVideoUrl(data.url),
    onError: (e) => setError(e instanceof Error ? e.message : "Video upload failed"),
  });

  const onPickVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // The upload travels as base64 JSON, which inflates ~33% against the API's
    // 30 MB body limit, so the practical ceiling is around 20 MB.
    if (file.size > MAX_VIDEO_BYTES) {
      setError(
        `${file.name} is ${Math.round(file.size / 1_000_000)} MB, keep uploads under ` +
          `${MAX_VIDEO_BYTES / 1_000_000} MB.`,
      );
      return;
    }
    upload.mutate(file);
  };

  const generating = generate.isPending || !!agentRunId;
  const currentStep = run?.output?.progress ?? "script";
  const currentStepIndex = STEP_ORDER.indexOf(currentStep);
  const percent = useEasedProgress(run?.output?.percent ?? 0, generating);

  return (
    <div className="space-y-3">
      <div>
        <Label>Video brief</Label>
        <Input
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="3 reasons our cold brew subscription beats coffee-shop prices"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Format</Label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {VIDEO_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {VIDEO_PRESETS[id].label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Length</Label>
          <select
            value={durationSec}
            onChange={(e) => setDurationSec(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {VIDEO_DURATIONS.map((d) => (
              <option key={d} value={d}>
                ~{d}s
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Voice</Label>
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {TTS_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-line px-3 py-2.5">
        <Switch
          checked={includeCaptions}
          onChange={setIncludeCaptions}
          label="Burn in subtitles"
          hint="Word-timed captions, most short-form video is watched muted."
        />
      </div>

      <Button
        className="w-full"
        loading={generating}
        disabled={brief.trim().length < 3}
        onClick={() => generate.mutate()}
      >
        <Clapperboard className="h-4 w-4" />
        {generating ? "Producing video…" : "Generate video"}
      </Button>
      <div className="flex items-center gap-3 py-0.5">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[11px] uppercase tracking-wide text-ink-4">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime"
        className="hidden"
        onChange={onPickVideo}
      />
      <Button
        variant="secondary"
        className="w-full"
        loading={upload.isPending}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-4 w-4" />
        {upload.isPending ? "Uploading…" : "Upload your own video"}
      </Button>
      <p className="text-xs text-ink-3">
        TikTok posts must be video. MP4 or MOV, up to {MAX_VIDEO_BYTES / 1_000_000} MB.
      </p>
      <ErrorNote message={error} />

      <LiveStatus
        message={
          generating
            ? percent > 0
              ? `Rendering video, ${Math.round(percent)}% complete`
              : "Rendering video"
            : videoUrl
              ? "Video ready"
              : null
        }
      />
      <LiveStatus message={error} urgent />

      {generating && (
        <div className="rounded-lg border border-dashed border-line p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
            >
              <Film className="h-4 w-4 text-accent" />
            </motion.div>
            <span className="flex-1">AI video pipeline running, usually 1-3 minutes</span>
            <span className="tnum font-mono text-[13px] text-ink-3">{percent}%</span>
          </div>
          <div
            className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Video generation progress"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <ol className="space-y-1.5">
            {STEP_ORDER.map((step, i) => (
              <li
                key={step}
                className={cx(
                  "flex items-center gap-2 text-xs",
                  i < currentStepIndex
                    ? "text-emerald-500"
                    : i === currentStepIndex
                      ? "text-ink"
                      : "text-ink-3",
                )}
              >
                <span
                  className={cx(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    i < currentStepIndex
                      ? "bg-emerald-500"
                      : i === currentStepIndex
                        ? "animate-pulse bg-accent"
                        : "bg-line",
                  )}
                />
                {STEP_LABELS[step]}
                {i === currentStepIndex && run?.output?.detail ? `, ${run.output.detail}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}

      {videoUrl && !generating && (
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}>
          <video
            src={videoUrl}
            controls
            playsInline
            className="max-h-96 w-full rounded-lg border border-line bg-black"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-xs text-emerald-500">
              ✓ {videoMeta?.title ?? "Video ready"}
              {videoMeta?.durationSec ? ` · ${Math.round(videoMeta.durationSec)}s` : ""}
              {contentItemId ? ", attached to this post" : ""}
            </p>
            {run?.costUsd && <span className="text-[14px] text-ink-3">${run.costUsd}</span>}
          </div>
        </motion.div>
      )}
    </div>
  );
}
