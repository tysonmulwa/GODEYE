"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Sparkles, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IMAGE_PRESETS, IMAGE_PRESET_IDS } from "@godeye/shared";
import { api } from "@/lib/api";
import { useEasedProgress } from "@/lib/use-eased-progress";
import { GodeyeSpinner } from "@/components/logo";
import { Button, ErrorNote, Input, Label, cx } from "@/components/ui";

interface AgentRun {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  output: {
    url?: string;
    mediaAssetId?: string;
    // Reported by the engine at each stage; see STAGES in tasks/image.py.
    percent?: number;
    detail?: string;
  } | null;
  error: string | null;
  costUsd: string | null;
}


interface MediaAsset {
  id: string;
  kind: string;
  url: string | null;
  source: string;
}

/**
 * X caps a post at 4 images and is the tightest of the platforms we publish to,
 * so it sets the ceiling — a post that fits everywhere.
 */
const MAX_IMAGES = 4;

/**
 * Image generation for a content item. Generates via the Image Agent, polls the
 * run, and shows the result — which the engine attaches to the content so it
 * publishes with the post.
 */
export function ImageStudio({
  contentItemId,
  defaultBrief,
  defaultPreset = "SQUARE",
  onGenerated,
}: {
  contentItemId?: string;
  defaultBrief?: string;
  defaultPreset?: string;
  onGenerated?: (url: string) => void;
}) {
  const [brief, setBrief] = useState(defaultBrief ?? "");
  const [preset, setPreset] = useState(defaultPreset);
  const [style, setStyle] = useState("");
  const [applyBrand, setApplyBrand] = useState(true);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Everything attached to this post — uploads and generated images alike, so
  // the count and the grid reflect what will actually publish.
  const { data: attached = [] } = useQuery<MediaAsset[]>({
    queryKey: ["media", contentItemId],
    queryFn: () => api(`/media?contentItemId=${contentItemId}`),
    enabled: !!contentItemId,
  });
  const images = attached.filter((m) => m.kind === "IMAGE" && m.url);
  const remaining = MAX_IMAGES - images.length;
  const refreshMedia = () =>
    queryClient.invalidateQueries({ queryKey: ["media", contentItemId] });

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
      return s === "SUCCEEDED" || s === "FAILED" ? false : 1500;
    },
  });

  useEffect(() => {
    if (!run) return;
    if (run.status === "SUCCEEDED" && run.output?.url) {
      // The engine attaches the generated image to the content item, so it
      // arrives through the media query alongside uploads.
      void refreshMedia();
      onGenerated?.(run.output.url);
      setAgentRunId(null);
    }
    if (run.status === "FAILED") {
      setError(run.error ?? "Image generation failed");
      setAgentRunId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const generate = useMutation({
    mutationFn: () =>
      api<{ agentRunId: string }>("/media/generate-image", {
        method: "POST",
        body: {
          prompt: brief,
          preset,
          style: style || undefined,
          contentItemId,
          applyBrand,
        },
      }),
    onMutate: () => setError(null),
    onSuccess: (data) => setAgentRunId(data.agentRunId),
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to start image generation"),
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const toBase64 = (file: File) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
          reader.readAsDataURL(file);
        });
      // Sequential, not parallel: each upload carries the whole image as base64
      // JSON, and firing four at once risks the API's body/rate limits.
      const uploaded: string[] = [];
      for (const file of files) {
        const res = await api<{ url: string }>("/media/upload", {
          method: "POST",
          body: {
            contentItemId,
            contentType: file.type,
            dataBase64: await toBase64(file),
            filename: file.name,
          },
        });
        uploaded.push(res.url);
      }
      return uploaded;
    },
    onMutate: () => setError(null),
    onSuccess: (urls) => {
      if (urls.length) onGenerated?.(urls[urls.length - 1]);
      void refreshMedia();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Upload failed"),
  });

  const removeMedia = useMutation({
    mutationFn: (id: string) => api(`/media/${id}`, { method: "DELETE" }),
    onSuccess: () => void refreshMedia(),
    onError: (e) => setError(e instanceof Error ? e.message : "Could not remove that image"),
  });

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be chosen again
    if (!picked.length) return;

    if (picked.length > remaining) {
      setError(
        `You can attach ${MAX_IMAGES} images per post — ${remaining} slot${remaining === 1 ? "" : "s"} left.`,
      );
      return;
    }
    const tooBig = picked.find((f) => f.size > 25_000_000);
    if (tooBig) {
      setError(`${tooBig.name} is larger than 25 MB`);
      return;
    }
    upload.mutate(picked);
  };

  const generating = generate.isPending || (!!agentRunId && run?.status !== "SUCCEEDED");
  const percent = useEasedProgress(run?.output?.percent ?? 0, generating);
  const stageLabel = run?.output?.detail ?? "Starting";

  return (
    <div className="space-y-3">
      <div>
        <Label>Image brief</Label>
        <Input
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="A steaming cup of cold brew on a rustic wooden table, morning light"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Size preset</Label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {IMAGE_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {IMAGE_PRESETS[id].label} · {IMAGE_PRESETS[id].width}×{IMAGE_PRESETS[id].height}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Style (optional)</Label>
          <Input
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="photorealistic, flat illustration…"
          />
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={applyBrand}
          onChange={(e) => setApplyBrand(e.target.checked)}
          className="accent-[var(--accent)]"
        />
        Apply brand overlay (logo + accent) from your brand kit
      </label>

      <Button
        className="w-full"
        loading={generating}
        disabled={brief.trim().length < 3}
        onClick={() => generate.mutate()}
      >
        <Sparkles className="h-4 w-4" />
        {/* The percentage lives under the bar, next to the stage it belongs to.
            Repeating it here showed the same number twice. */}
        {generating ? "Generating image…" : "Generate image"}
      </Button>

      {generating && (
        <div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Image generation progress"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 flex justify-between font-mono text-[12px] text-ink-3">
            <span>{stageLabel}</span>
            <span className="tnum">{percent}%</span>
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 py-0.5">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[11px] uppercase tracking-wide text-ink-4">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={onPickFiles}
      />
      <Button
        variant="secondary"
        className="w-full"
        loading={upload.isPending}
        disabled={remaining <= 0}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-4 w-4" />
        {upload.isPending
          ? "Uploading…"
          : remaining <= 0
            ? `Maximum ${MAX_IMAGES} images attached`
            : `Upload photos (${remaining} of ${MAX_IMAGES} left)`}
      </Button>
      <ErrorNote message={error} />

      {generating && (
        <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line">
          <GodeyeSpinner size={46} className="text-accent" />
          <span className="text-xs text-ink-3">Painting your image…</span>
        </div>
      )}

      {images.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
          <div className="mb-1.5 flex items-center justify-between">
            <Label>
              Attached ({images.length}/{MAX_IMAGES})
            </Label>
            {run?.costUsd && <span className="text-[12px] text-ink-3">Cost: ${run.costUsd}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {images.map((m) => (
              <div key={m.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={m.url as string}
                  alt=""
                  className="aspect-square w-full rounded-lg border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeMedia.mutate(m.id)}
                  aria-label="Remove image"
                  title="Remove"
                  className="hover-reveal absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white hover:bg-red-600"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-emerald-500">
            ✓ {images.length === 1 ? "Attached" : `${images.length} images attached`} — they
            publish with this post.
          </p>
        </motion.div>
      )}

    </div>
  );
}
