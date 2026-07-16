"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, CheckCircle2, Link2, PenSquare, XCircle } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

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

export default function DashboardPage() {
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

  const published = posts.filter((p) => p.status === "PUBLISHED").length;
  const pending = posts.filter((p) => p.status === "PENDING" || p.status === "PROCESSING").length;
  const failed = posts.filter((p) => p.status === "FAILED").length;
  const activeConnections = connections.filter((c) => c.status === "ACTIVE").length;

  const stats = [
    { label: "Active connections", value: activeConnections, icon: Link2 },
    { label: "Queued posts", value: pending, icon: CalendarClock },
    { label: "Published", value: published, icon: CheckCircle2 },
    { label: "Failed", value: failed, icon: XCircle },
  ];

  const recent = [...posts]
    .sort((a, b) => +new Date(b.scheduledAt) - +new Date(a.scheduledAt))
    .slice(0, 8);

  return (
    <>
      <PageHeader
        title={`Welcome back${user ? `, ${user.name.split(" ")[0]}` : ""}`}
        subtitle="Here's what your AI marketing team has been doing."
        actions={
          <Link
            href="/composer"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover"
          >
            <PenSquare className="h-4 w-4" /> New post
          </Link>
        }
      />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label} className="!p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-ink-3">{label}</p>
              <Icon className="h-4 w-4 text-ink-3" />
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </Card>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink-2">Recent activity</h2>
        <Link
          href="/calendar"
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          Full calendar <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {recent.length === 0 ? (
        <EmptyState
          title="No activity yet"
          hint="Connect a platform, then generate and schedule your first AI post from the Composer."
        />
      ) : (
        <div className="space-y-2">
          {recent.map((post) => (
            <Card key={post.id} className="flex items-center gap-4 !p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{post.contentPreview}</p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {post.platform} · {post.connectionName} ·{" "}
                  {new Date(post.scheduledAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <Badge status={post.status} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
