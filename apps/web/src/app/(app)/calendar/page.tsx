"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { PlatformGlyph, cx, platformColor } from "@/components/ui";

interface ScheduledPost {
  id: string;
  platform: string;
  connectionName: string;
  scheduledAt: string;
  status: string;
  publishedAt: string | null;
  externalPostUrl: string | null;
  error: string | null;
  contentPreview: string;
}

function startOfWeek(anchor: Date): Date {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d;
}

const DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const [weekOffset, setWeekOffset] = useState(0);

  const anchor = new Date();
  anchor.setDate(anchor.getDate() + weekOffset * 7);
  const weekStart = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const { data: posts = [] } = useQuery<ScheduledPost[]>({
    queryKey: ["schedule", weekStart.toISOString()],
    queryFn: () =>
      api(`/schedule?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`),
    refetchInterval: 20_000,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api(`/schedule/${id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedule"] }),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => api(`/schedule/${id}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedule"] }),
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monthLabel = weekStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const weekNo = Math.ceil(
    ((+weekStart - +new Date(weekStart.getFullYear(), 0, 1)) / 86_400_000 + 1) / 7,
  );

  const postsFor = (day: Date) =>
    posts
      .filter((p) => {
        const t = new Date(p.scheduledAt);
        return (
          t.getFullYear() === day.getFullYear() &&
          t.getMonth() === day.getMonth() &&
          t.getDate() === day.getDate()
        );
      })
      .sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt));

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-bold tracking-[-0.02em]">Calendar</h1>
          <p className="mt-1 font-mono text-[14px] text-ink-3">
            {monthLabel.toLowerCase()} · week {weekNo} · {posts.length} scheduled
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setWeekOffset((w) => w - 1)}
            aria-label="Previous week"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-line-hover"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {weekOffset !== 0 && (
            <button
              onClick={() => setWeekOffset(0)}
              className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[14px] text-ink-2 transition-colors hover:border-line-hover"
            >
              today
            </button>
          )}
          <button
            onClick={() => setWeekOffset((w) => w + 1)}
            aria-label="Next week"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-line-hover"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[11px] border border-line bg-surface-2">
        <div className="grid min-w-[900px] grid-cols-7">
          {days.map((day, i) => {
            const isToday = +day === +today;
            const dayPosts = postsFor(day);
            return (
              <div
                key={i}
                className={cx("min-h-[470px]", i > 0 && "border-l border-line-soft")}
              >
                <div
                  className={cx(
                    "border-b border-line-soft px-3 py-2.5",
                    isToday && "bg-accent-soft",
                  )}
                >
                  <p
                    className={cx(
                      "font-mono text-[12px] font-semibold tracking-[0.08em]",
                      isToday ? "text-accent-hover" : "text-ink-4",
                    )}
                  >
                    {DOW[i]}
                  </p>
                  <p
                    className={cx(
                      "tnum text-[17px] font-bold leading-tight",
                      isToday ? "text-accent-hover" : "",
                    )}
                  >
                    {day.getDate()}
                  </p>
                </div>
                <div className="space-y-1.5 p-2">
                  {dayPosts.map((post) => (
                    <div
                      key={post.id}
                      className="group rounded-[7px] border border-line-soft bg-sidebar p-2 transition-colors hover:bg-surface-3"
                      style={{ borderLeft: `3px solid ${platformColor(post.platform)}` }}
                      title={post.error ?? post.contentPreview}
                    >
                      <div className="flex items-center gap-1.5">
                        <PlatformGlyph platform={post.platform} size={16} />
                        <span className="tnum font-mono text-[12px] text-ink-3">
                          {new Date(post.scheduledAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span
                          className={cx(
                            "ml-auto font-mono text-[14px] font-semibold uppercase",
                            post.status === "PUBLISHED" && "text-emerald-600",
                            post.status === "FAILED" && "text-red-600",
                            post.status === "PENDING" && "text-amber-600",
                            post.status === "PROCESSING" && "text-blue-600",
                            post.status === "CANCELLED" && "text-ink-4",
                          )}
                        >
                          {post.status === "PENDING" ? "" : post.status.slice(0, 4)}
                        </span>
                        {post.externalPostUrl && (
                          <a
                            href={post.externalPostUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Open published post"
                            className="hidden text-ink-3 hover:text-accent group-hover:block"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {post.status === "PENDING" && (
                          <button
                            onClick={() => cancelMutation.mutate(post.id)}
                            aria-label="Cancel"
                            className="hidden text-ink-3 hover:text-red-500 group-hover:block"
                          >
                            <XCircle className="h-3 w-3" />
                          </button>
                        )}
                        {post.status === "FAILED" && (
                          <button
                            onClick={() => retryMutation.mutate(post.id)}
                            disabled={retryMutation.isPending}
                            aria-label="Retry"
                            title={post.error ?? "Retry this post"}
                            className="text-ink-3 hover:text-accent"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[14px] leading-snug">
                        {post.contentPreview}
                      </p>
                      {post.status === "FAILED" && post.error && (
                        <p className="mt-0.5 line-clamp-2 font-mono text-[11px] text-red-500">
                          {post.error}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
