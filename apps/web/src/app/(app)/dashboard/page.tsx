"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, PenSquare } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LiveDot,
  MonoChip,
  MonoLabel,
  PlatformGlyph,
  Sparkline,
  Switch,
  cx,
} from "@/components/ui";

interface ScheduledPost {
  id: string;
  platform: string;
  connectionName: string;
  scheduledAt: string;
  status: string;
  contentPreview: string;
  error: string | null;
}

interface Connection {
  id: string;
  status: string;
}

interface Plan {
  id: string;
  name: string;
  active: boolean;
  autoGenerate: boolean;
  preferredTimes: string[];
  platforms: string[];
}

interface PendingContent {
  id: string;
  title: string | null;
  body: string;
  aiGenerated: boolean;
  submittedAt: string | null;
  submittedByName: string | null;
}

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const timeShort = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Posts per day for the last 7 days — real sparkline data from the schedule. */
function weeklySeries(posts: ScheduledPost[]): number[] {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (6 - i));
    return d.getTime();
  });
  return days.map(
    (start) =>
      posts.filter((p) => {
        const t = +new Date(p.scheduledAt);
        return t >= start && t < start + 86_400_000;
      }).length,
  );
}

function ApprovalsCard() {
  const queryClient = useQueryClient();
  const { organization } = useAuthStore();
  const isReviewer = ["OWNER", "ADMIN"].includes(organization?.role ?? "");

  const { data: pending = [] } = useQuery<PendingContent[]>({
    queryKey: ["content", "PENDING_APPROVAL"],
    queryFn: () => api("/content?status=PENDING_APPROVAL"),
    enabled: isReviewer,
    refetchInterval: 30_000,
  });

  const review = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" }) =>
      api(`/content/${id}/${action}`, { method: "POST", body: {} }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["content", "PENDING_APPROVAL"] });
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
  });

  if (!isReviewer) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13.5px] font-semibold">Approvals</h2>
        {pending.length > 0 && (
          <span className="rounded-full bg-amber-500/13 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-600">
            {pending.length} queued
          </span>
        )}
      </div>
      {pending.length === 0 ? (
        <p className="font-mono text-[11px] text-ink-3">queue empty</p>
      ) : (
        <ul className="space-y-3">
          {pending.slice(0, 4).map((item) => (
            <li key={item.id}>
              <p className="line-clamp-2 text-[12.5px] leading-snug">{item.title ?? item.body}</p>
              <p className="mt-0.5 font-mono text-[10.5px] text-ink-4">
                {item.aiGenerated ? "autopilot" : (item.submittedByName ?? "teammate")}
                {item.submittedAt ? ` · ${timeShort(item.submittedAt)}` : ""}
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={() => review.mutate({ id: item.id, action: "approve" })}
                  className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-accent-hover"
                >
                  Approve
                </button>
                <button
                  onClick={() => review.mutate({ id: item.id, action: "reject" })}
                  className="rounded-md border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-line-hover"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const { data: posts = [] } = useQuery<ScheduledPost[]>({
    queryKey: ["schedule"],
    queryFn: () => api("/schedule"),
    refetchInterval: 20_000,
  });
  const { data: connections = [] } = useQuery<Connection[]>({
    queryKey: ["connections"],
    queryFn: () => api("/connections"),
  });
  const { data: plans = [] } = useQuery<Plan[]>({
    queryKey: ["posting-plans"],
    queryFn: () => api("/posting-plans"),
  });

  const togglePlan = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api(`/posting-plans/${id}`, { method: "PATCH", body: { active } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posting-plans"] }),
  });

  const published = posts.filter((p) => p.status === "PUBLISHED");
  const queued = posts.filter((p) => p.status === "PENDING" || p.status === "PROCESSING");
  const failed24h = posts.filter(
    (p) => p.status === "FAILED" && Date.now() - +new Date(p.scheduledAt) < 86_400_000,
  ).length;
  const activeConnections = connections.filter((c) => c.status === "ACTIVE").length;
  const series = weeklySeries(posts);

  const autopilotPlan = plans.find((p) => p.autoGenerate) ?? null;
  const nextPost = [...queued].sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt))[0];

  const kpis = [
    { label: "Channels", value: activeConnections, spark: null },
    { label: "Queued", value: queued.length, spark: null },
    { label: "Published", value: published.length, spark: series },
    { label: "Failed · 24h", value: failed24h, spark: null },
  ];

  const recent = [...posts]
    .sort((a, b) => +new Date(b.scheduledAt) - +new Date(a.scheduledAt))
    .slice(0, 8);

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-bold tracking-[-0.02em]">
            Overview
          </h1>
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[11.5px] text-ink-3">
            <LiveDot />
            <span>
              live · {activeConnections} channel{activeConnections === 1 ? "" : "s"} ·{" "}
              {queued.length} queued
            </span>
          </div>
        </div>
        <Link href="/composer">
          <Button>
            <PenSquare className="h-4 w-4" /> New post
          </Button>
        </Link>
      </div>

      <div className="mb-3.5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(({ label, value, spark }) => (
          <Card key={label} className="flex items-start justify-between !p-4">
            <div>
              <MonoLabel>{label}</MonoLabel>
              <p className="tnum mt-1.5 text-[25px] font-bold leading-none">{value}</p>
            </div>
            {spark && <Sparkline points={spark} className="mt-1" />}
          </Card>
        ))}
      </div>

      {autopilotPlan && (
        <Card className="mb-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 !py-3">
          <div className="flex items-center gap-2">
            <LiveDot color={autopilotPlan.active ? "#10b981" : "#98a0ad"} pulse={autopilotPlan.active} />
            <span className="text-[13px] font-semibold">Autopilot</span>
            <MonoChip>{kebab(autopilotPlan.name)}</MonoChip>
            <Badge status={autopilotPlan.active ? "ACTIVE" : "PAUSED"} />
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            {autopilotPlan.preferredTimes.length > 0 && (
              <span className="hidden truncate font-mono text-[11px] text-ink-3 md:block">
                NEXT SLOTS · {autopilotPlan.preferredTimes.slice(0, 3).join(" · ")}
              </span>
            )}
            {nextPost && (
              <span className="hidden font-mono text-[11px] text-ink-3 sm:block">
                NEXT POST {timeShort(nextPost.scheduledAt)}
              </span>
            )}
            <Switch
              checked={autopilotPlan.active}
              onChange={(v) => togglePlan.mutate({ id: autopilotPlan.id, active: v })}
            />
          </div>
        </Card>
      )}

      <div className="grid gap-3.5 lg:grid-cols-[1.62fr_1fr]">
        <Card className="!p-0">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <h2 className="text-[13.5px] font-semibold">Recent activity</h2>
            <Link
              href="/calendar"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-accent-hover hover:underline"
            >
              calendar <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                title="No activity yet"
                hint="Connect a platform, then generate and schedule your first AI post from the Composer."
              />
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-[30px_minmax(0,1fr)_110px_88px] items-center gap-3 border-b border-line-soft px-4 pb-2">
                {["", "POST", "WHEN", "STATUS"].map((h, i) => (
                  <span
                    key={i}
                    className={cx(
                      "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-4",
                      h === "STATUS" && "text-right",
                    )}
                  >
                    {h}
                  </span>
                ))}
              </div>
              <ul className="divide-y divide-line-soft">
                {recent.map((post) => (
                  <li
                    key={post.id}
                    className="grid grid-cols-[30px_minmax(0,1fr)_110px_88px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface"
                  >
                    <PlatformGlyph platform={post.platform} size={24} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px]">{post.contentPreview}</p>
                      <p className="truncate font-mono text-[10.5px] text-ink-4">
                        {post.connectionName}
                      </p>
                    </div>
                    <span className="font-mono text-[11px] text-ink-3">
                      {timeShort(post.scheduledAt)}
                    </span>
                    <span className="text-right">
                      <Badge status={post.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <div className="space-y-3.5 self-start">
          <ApprovalsCard />
          <Card>
            <MonoLabel className="mb-3">Signals</MonoLabel>
            <ul className="space-y-2 font-mono text-[11.5px]">
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-2">published · total</span>
                <span className="tnum font-semibold text-emerald-600">{published.length}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-2">failed · 24h</span>
                <span className={cx("tnum font-semibold", failed24h > 0 ? "text-red-600" : "")}>
                  {failed24h}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-2">next post</span>
                <span className="truncate text-ink">
                  {nextPost ? timeShort(nextPost.scheduledAt) : "—"}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-2">owner</span>
                <span className="truncate text-ink">{user?.name?.split(" ")[0]?.toLowerCase()}</span>
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
