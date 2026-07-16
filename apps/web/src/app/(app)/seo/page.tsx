"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Copy, Download, Gauge, Globe, Search } from "lucide-react";
import { useState } from "react";
import { api, API_URL } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  cx,
} from "@/components/ui";

interface AuditSummary {
  id: string;
  url: string;
  status: string;
  score: number | null;
  pagesCrawled: number;
  error: string | null;
  createdAt: string;
}

interface Finding {
  severity: "critical" | "warning" | "info";
  code: string;
  page: string;
  message: string;
  recommendation: string;
}

interface AuditDetail extends AuditSummary {
  findings: Finding[] | null;
  keywords: { clusters: { topic: string; intent: string; keywords: string[] }[] } | null;
  metaSuggestions:
    | {
        page: string;
        currentTitle: string | null;
        suggestedTitle: string;
        currentDescription: string | null;
        suggestedDescription: string;
      }[]
    | null;
  schemaMarkup: Record<string, unknown> | null;
  hasSitemap: boolean;
  hasRobots: boolean;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? "#10b981" : score >= 55 ? "#f59e0b" : "#ef4444";
  const circumference = 2 * Math.PI * 42;
  return (
    <div className="relative h-28 w-28">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r="42" fill="none" stroke="var(--line)" strokeWidth="9" />
        <motion.circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - score / 100) }}
          transition={{ duration: 1, ease: "easeOut" }}
          strokeDasharray={circumference}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums">{score}</span>
        <span className="text-[10px] text-ink-3">SEO score</span>
      </div>
    </div>
  );
}

export default function SeoPage() {
  const queryClient = useQueryClient();
  const org = useAuthStore((s) => s.organization);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [url, setUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const { data: audits = [] } = useQuery<AuditSummary[]>({
    queryKey: ["seo-audits"],
    queryFn: () => api("/seo/audits"),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === "QUEUED" || a.status === "RUNNING")
        ? 3000
        : false,
  });

  const activeId = selectedId ?? audits[0]?.id ?? null;
  const { data: detail } = useQuery<AuditDetail>({
    queryKey: ["seo-audit", activeId],
    queryFn: () => api(`/seo/audits/${activeId}`),
    enabled: !!activeId,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "QUEUED" || s === "RUNNING" ? 3000 : false;
    },
  });

  const runAudit = useMutation({
    mutationFn: () =>
      api<{ auditId: string }>("/seo/audit", {
        method: "POST",
        body: { url: url || undefined, maxPages: 20 },
      }),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      setSelectedId(data.auditId);
      queryClient.invalidateQueries({ queryKey: ["seo-audits"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed to start audit"),
  });

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const download = async (kind: "sitemap.xml" | "robots.txt") => {
    const res = await fetch(`${API_URL}/seo/audits/${activeId}/${kind}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = kind;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sortedFindings = [...(detail?.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const running = detail?.status === "QUEUED" || detail?.status === "RUNNING";

  return (
    <>
      <PageHeader
        title="SEO"
        subtitle="Crawl your site, find what's holding rankings back, and get AI-written fixes."
      />

      {/* Run bar */}
      <Card className="mb-6 !p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Label>Website URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={`https://… (blank = your profile website${org ? "" : ""})`}
            />
          </div>
          <Button loading={runAudit.isPending} onClick={() => runAudit.mutate()}>
            <Search className="h-4 w-4" /> Run audit
          </Button>
        </div>
        <ErrorNote message={error} />
      </Card>

      {audits.length === 0 && !runAudit.isPending ? (
        <EmptyState
          title="No audits yet"
          hint="Run your first audit — GODEYE crawls up to 20 pages and scores your technical SEO."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-4">
          {/* History */}
          <div className="space-y-2 lg:col-span-1">
            {audits.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                className={cx(
                  "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                  a.id === activeId ? "border-accent bg-accent-soft/40" : "border-line hover:border-ink-3",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">
                    {a.url.replace(/^https?:\/\//, "")}
                  </span>
                  {a.score !== null && (
                    <span className="text-xs font-bold tabular-nums">{a.score}</span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Badge status={a.status === "SUCCEEDED" ? "PUBLISHED" : a.status === "RUNNING" ? "PROCESSING" : a.status} />
                  <span className="text-[10px] text-ink-3">
                    {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Detail */}
          <div className="space-y-4 lg:col-span-3">
            {running && (
              <Card className="flex items-center gap-3">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 2.5, ease: "linear" }}
                >
                  <Globe className="h-5 w-5 text-accent" />
                </motion.div>
                <div>
                  <p className="text-sm font-medium">Auditing {detail?.url}…</p>
                  <p className="text-xs text-ink-3">
                    Crawling pages, checking rules, researching keywords — 1–2 minutes.
                  </p>
                </div>
              </Card>
            )}

            {detail?.status === "FAILED" && <ErrorNote message={detail.error ?? "Audit failed"} />}

            {detail?.status === "SUCCEEDED" && detail.score !== null && (
              <>
                {/* Score + artifacts */}
                <Card className="flex items-center gap-6">
                  <ScoreRing score={detail.score} />
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{detail.url}</p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {detail.pagesCrawled} pages crawled · {detail.findings?.length ?? 0} findings
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {detail.hasSitemap && (
                        <Button variant="secondary" onClick={() => download("sitemap.xml")}>
                          <Download className="h-3.5 w-3.5" /> sitemap.xml
                        </Button>
                      )}
                      {detail.hasRobots && (
                        <Button variant="secondary" onClick={() => download("robots.txt")}>
                          <Download className="h-3.5 w-3.5" /> robots.txt
                        </Button>
                      )}
                      {detail.schemaMarkup && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            copy(JSON.stringify(detail.schemaMarkup, null, 2), "schema")
                          }
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {copied === "schema" ? "Copied!" : "Copy JSON-LD"}
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>

                {/* Keywords */}
                {detail.keywords?.clusters && (
                  <Card>
                    <h2 className="mb-3 text-sm font-semibold">Keyword opportunities</h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {detail.keywords.clusters.map((cluster) => (
                        <div key={cluster.topic} className="rounded-lg border border-line p-3">
                          <div className="mb-1.5 flex items-center justify-between">
                            <p className="text-xs font-semibold">{cluster.topic}</p>
                            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-ink-2">
                              {cluster.intent}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {cluster.keywords.map((keyword) => (
                              <span
                                key={keyword}
                                className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent"
                              >
                                {keyword}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* Meta suggestions */}
                {detail.metaSuggestions && detail.metaSuggestions.length > 0 && (
                  <Card>
                    <h2 className="mb-3 text-sm font-semibold">AI meta tag rewrites</h2>
                    <div className="space-y-3">
                      {detail.metaSuggestions.map((suggestion, i) => (
                        <div key={i} className="rounded-lg border border-line p-3">
                          <p className="mb-2 truncate text-[11px] text-ink-3">{suggestion.page}</p>
                          <div className="space-y-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[10px] uppercase tracking-wide text-ink-3">Title</p>
                                <p className="text-sm font-medium">{suggestion.suggestedTitle}</p>
                              </div>
                              <button
                                onClick={() => copy(suggestion.suggestedTitle, `t${i}`)}
                                className="rounded p-1.5 text-ink-3 hover:text-accent"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[10px] uppercase tracking-wide text-ink-3">Description</p>
                                <p className="text-xs text-ink-2">{suggestion.suggestedDescription}</p>
                              </div>
                              <button
                                onClick={() => copy(suggestion.suggestedDescription, `d${i}`)}
                                className="rounded p-1.5 text-ink-3 hover:text-accent"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* Findings */}
                <Card>
                  <h2 className="mb-3 text-sm font-semibold">
                    Findings ({sortedFindings.length})
                  </h2>
                  {sortedFindings.length === 0 ? (
                    <p className="text-sm text-emerald-500">No issues found — clean site! 🎉</p>
                  ) : (
                    <div className="space-y-2">
                      {sortedFindings.map((finding, i) => (
                        <details key={i} className="rounded-lg border border-line px-3 py-2">
                          <summary className="flex cursor-pointer items-center gap-2">
                            <span
                              className={cx(
                                "inline-block h-2 w-2 shrink-0 rounded-full",
                                finding.severity === "critical"
                                  ? "bg-red-500"
                                  : finding.severity === "warning"
                                    ? "bg-amber-500"
                                    : "bg-blue-400",
                              )}
                            />
                            <span className="flex-1 text-sm">{finding.message}</span>
                            <span className="text-[10px] uppercase text-ink-3">{finding.severity}</span>
                          </summary>
                          <div className="mt-2 space-y-1 pl-4">
                            <p className="truncate text-[11px] text-ink-3">{finding.page}</p>
                            <p className="text-xs text-ink-2">{finding.recommendation}</p>
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </Card>
              </>
            )}

            {!detail && !running && audits.length > 0 && (
              <Card className="flex min-h-40 items-center justify-center">
                <div className="text-center text-ink-3">
                  <Gauge className="mx-auto mb-2 h-8 w-8" />
                  <p className="text-sm">Select an audit to view results</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
