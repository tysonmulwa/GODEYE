"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ImageIcon, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { IMAGE_PRESETS, IMAGE_PRESET_IDS } from "@godeye/shared";
import { api } from "@/lib/api";
import { Button, ErrorNote, Input, Label, cx } from "@/components/ui";

interface AgentRun {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  output: { url?: string; mediaAssetId?: string } | null;
  error: string | null;
  costUsd: string | null;
}

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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
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
      return s === "SUCCEEDED" || s === "FAILED" ? false : 1500;
    },
  });

  useEffect(() => {
    if (!run) return;
    if (run.status === "SUCCEEDED" && run.output?.url) {
      setImageUrl(run.output.url);
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
    onMutate: () => {
      setError(null);
      setImageUrl(null);
    },
    onSuccess: (data) => setAgentRunId(data.agentRunId),
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to start image generation"),
  });

  const generating = generate.isPending || (!!agentRunId && run?.status !== "SUCCEEDED");

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
        {generating ? "Generating image…" : "Generate image"}
      </Button>
      <ErrorNote message={error} />

      {generating && (
        <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-line">
          <motion.div
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ repeat: Infinity, duration: 1.6 }}
            className="flex flex-col items-center gap-2 text-ink-3"
          >
            <ImageIcon className="h-8 w-8" />
            <span className="text-xs">Painting your image…</span>
          </motion.div>
        </div>
      )}

      {imageUrl && !generating && (
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Generated"
            className={cx("w-full rounded-lg border border-line")}
          />
          {contentItemId && (
            <p className="mt-1.5 text-xs text-emerald-500">
              ✓ Attached to this post — it will publish with the image.
            </p>
          )}
          {run?.costUsd && <p className="mt-0.5 text-[11px] text-ink-3">Cost: ${run.costUsd}</p>}
        </motion.div>
      )}
    </div>
  );
}
