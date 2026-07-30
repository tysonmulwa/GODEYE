"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  RefreshCw,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import { api, API_URL } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Badge, Button, Card, ErrorNote, cx } from "@/components/ui";

export interface SeoFix {
  id: string;
  findingCode: string;
  kind: "HEAD_TAG" | "FILE" | "ATTRIBUTE" | "MANUAL";
  channel: string;
  status: "PROPOSED" | "APPLIED" | "VERIFIED" | "FAILED" | "DISMISSED";
  severity: "critical" | "warning" | "info";
  targetUrl: string;
  title: string;
  before: string | null;
  after: string | null;
  filePath: string | null;
  guidance: string;
  appliedAt: string | null;
  verifiedAt: string | null;
  error: string | null;
}

interface IndexNowStatus {
  key: string;
  keyFileUrl: string;
  published: boolean;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-400",
};

/** What the user is meant to do with each kind of change. */
const KIND_HINT: Record<SeoFix["kind"], string> = {
  HEAD_TAG: "Paste into the page's head",
  FILE: "Publish this file at the site root",
  ATTRIBUTE: "Edit the markup",
  MANUAL: "Needs a decision from you",
};

function CodeBlock({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.09em] text-ink-3">
          {label}
        </span>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] text-ink-3 hover:text-accent"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto overscroll-x-contain rounded-lg border border-line bg-surface-3 p-2.5 font-mono text-[12px] leading-relaxed text-ink-2">
        {body}
      </pre>
    </div>
  );
}

export function SeoFixes({ auditId, platform }: { auditId: string; platform: string | null }) {
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: fixes = [] } = useQuery<SeoFix[]>({
    queryKey: ["seo-fixes", auditId],
    queryFn: () => api(`/seo/audits/${auditId}/fixes`),
  });

  const { data: indexNow } = useQuery<IndexNowStatus>({
    queryKey: ["seo-indexnow", auditId],
    queryFn: () => api(`/seo/audits/${auditId}/indexnow`),
    retry: false,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["seo-fixes", auditId] });
    queryClient.invalidateQueries({ queryKey: ["seo-indexnow", auditId] });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/seo/fixes/${id}`, { method: "PATCH", body: { status } }),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : "Could not update this fix"),
  });

  const markAllApplied = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ updated: number }>("/seo/fixes/bulk", {
        method: "POST",
        body: { ids, status: "APPLIED" },
      }),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (data) => {
      setNotice(`Marked ${data.updated} fix(es) applied. Verify them when you're ready.`);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not update those fixes"),
  });

  const verify = useMutation({
    mutationFn: () =>
      api<{ checking: number }>(`/seo/audits/${auditId}/verify`, { method: "POST" }),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (data) => {
      setNotice(
        `Re-crawling ${data.checking} page(s) to confirm the changes are live. This takes a minute.`,
      );
      setTimeout(invalidate, 20_000);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start verification"),
  });

  const submit = useMutation({
    mutationFn: () =>
      api<{ submitted: number; status: string; reason?: string }>(
        `/seo/audits/${auditId}/indexnow`,
        { method: "POST", body: {} },
      ),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (data) => {
      if (data.status === "accepted") {
        setNotice(`Submitted ${data.submitted} URL(s) to Bing, Yandex, Seznam and Naver.`);
      } else {
        setError(data.reason ?? `Submission ${data.status}`);
      }
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not submit"),
  });

  const download = async () => {
    const res = await fetch(`${API_URL}/seo/audits/${auditId}/fix-pack.md`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "godeye-seo-fixes.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (fixes.length === 0) return null;

  const open_ = fixes.filter((f) => f.status === "PROPOSED");
  const applied = fixes.filter((f) => f.status === "APPLIED" || f.status === "FAILED");
  const verified = fixes.filter((f) => f.status === "VERIFIED");

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Fixes ({fixes.length})</h2>
          <p className="mt-0.5 font-mono text-[12px] text-ink-3">
            {open_.length} open · {applied.length} awaiting check · {verified.length} verified
            {platform ? ` · written for ${platform}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={download}>
            <Download className="h-3.5 w-3.5" /> Fix pack
          </Button>
          {open_.length > 0 && (
            <Button
              variant="secondary"
              loading={markAllApplied.isPending}
              onClick={() => markAllApplied.mutate(open_.map((f) => f.id))}
              title="Tell GODEYE you've made all of these changes"
            >
              <Check className="h-3.5 w-3.5" /> Mark all applied
            </Button>
          )}
          {applied.length > 0 && (
            <Button loading={verify.isPending} onClick={() => verify.mutate()}>
              <RefreshCw className="h-3.5 w-3.5" /> Verify {applied.length}
            </Button>
          )}
        </div>
      </div>

      <ErrorNote message={error} />
      {notice && (
        <p className="mb-3 rounded-lg border border-line bg-surface-3 px-3 py-2 text-[13px] text-ink-2">
          {notice}
        </p>
      )}

      {/* Search-engine notification. Deliberately explicit about which engines
          this reaches — Google is not one of them and pretending otherwise is
          the most common lie in this category of tool. */}
      {indexNow && (
        <div className="mb-3 rounded-lg border border-line bg-surface-3 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">
                Instant indexing{" "}
                {indexNow.published ? (
                  <span className="text-emerald-600">· key published</span>
                ) : (
                  <span className="text-amber-600">· key not published yet</span>
                )}
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">
                {indexNow.published
                  ? "Bing, Yandex, Seznam and Naver accept submissions for this site. Google has no equivalent — there the sitemap is the route."
                  : "Publish the IndexNow key file listed in the fixes below, then search engines will accept instant submissions for this site."}
              </p>
            </div>
            {indexNow.published && verified.length > 0 && (
              <Button variant="secondary" loading={submit.isPending} onClick={() => submit.mutate()}>
                <Send className="h-3.5 w-3.5" /> Notify engines
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {fixes.map((fix) => {
          const isOpen = open === fix.id;
          return (
            <div
              key={fix.id}
              className={cx(
                "rounded-lg border transition-colors",
                fix.status === "DISMISSED" ? "border-line-soft opacity-55" : "border-line",
              )}
            >
              <button
                onClick={() => setOpen(isOpen ? null : fix.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span
                  className={cx(
                    "inline-block h-2 w-2 shrink-0 rounded-full",
                    SEVERITY_DOT[fix.severity] ?? "bg-zinc-400",
                  )}
                />
                <span className="flex-1 truncate text-sm">{fix.title}</span>
                <Badge status={fix.status} />
                <ChevronDown
                  className={cx(
                    "h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </button>

              {isOpen && (
                <div className="border-t border-line-soft px-3 py-2.5">
                  <p className="truncate font-mono text-[12px] text-ink-3">{fix.targetUrl}</p>
                  <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.08em] text-ink-4">
                    {KIND_HINT[fix.kind]}
                  </p>

                  {fix.before && <CodeBlock label="currently" body={fix.before} />}
                  {fix.after && (
                    <CodeBlock label={fix.before ? "change to" : "add this"} body={fix.after} />
                  )}

                  <p className="mt-2.5 whitespace-pre-line text-[13px] leading-relaxed text-ink-2">
                    {fix.guidance}
                  </p>

                  {fix.status === "FAILED" && fix.error && (
                    <p className="mt-2 rounded border border-red-500/30 bg-red-500/8 px-2.5 py-1.5 font-mono text-[12px] text-red-500">
                      {fix.error}
                    </p>
                  )}
                  {fix.status === "VERIFIED" && (
                    <p className="mt-2 font-mono text-[12px] text-emerald-600">
                      Confirmed live on the site
                      {fix.verifiedAt ? ` · ${new Date(fix.verifiedAt).toLocaleString()}` : ""}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {fix.status !== "APPLIED" && fix.status !== "VERIFIED" && (
                      <Button
                        variant="secondary"
                        onClick={() => setStatus.mutate({ id: fix.id, status: "APPLIED" })}
                      >
                        <Check className="h-3.5 w-3.5" /> I&apos;ve applied this
                      </Button>
                    )}
                    {fix.status !== "DISMISSED" && fix.status !== "VERIFIED" && (
                      <Button
                        variant="ghost"
                        onClick={() => setStatus.mutate({ id: fix.id, status: "DISMISSED" })}
                        title="Not relevant to this site"
                      >
                        <X className="h-3.5 w-3.5" /> Dismiss
                      </Button>
                    )}
                    {(fix.status === "DISMISSED" || fix.status === "APPLIED") && (
                      <Button
                        variant="ghost"
                        onClick={() => setStatus.mutate({ id: fix.id, status: "PROPOSED" })}
                      >
                        <Undo2 className="h-3.5 w-3.5" /> Reopen
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
