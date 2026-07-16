"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

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

function groupByDay(posts: ScheduledPost[]): Map<string, ScheduledPost[]> {
  const groups = new Map<string, ScheduledPost[]>();
  for (const post of posts) {
    const day = new Date(post.scheduledAt).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(post);
  }
  return groups;
}

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const { data: posts = [], isLoading } = useQuery<ScheduledPost[]>({
    queryKey: ["schedule"],
    queryFn: () => api("/schedule"),
    refetchInterval: 20_000,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api(`/schedule/${id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedule"] }),
  });

  const groups = groupByDay(posts);

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle="Everything queued, publishing, published, or failed — updated live."
      />

      {isLoading ? null : posts.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          hint="Generate a post in the Composer and schedule it — it will show up here."
        />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([day, dayPosts]) => (
            <section key={day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
                {day}
              </h2>
              <div className="space-y-2">
                {dayPosts.map((post) => (
                  <Card key={post.id} className="flex items-center gap-4 !p-4">
                    <div className="w-14 shrink-0 text-center">
                      <p className="text-sm font-semibold tabular-nums">
                        {new Date(post.scheduledAt).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{post.contentPreview}</p>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {post.platform} · {post.connectionName}
                      </p>
                      {post.error && (
                        <p className="mt-0.5 truncate text-xs text-red-500">{post.error}</p>
                      )}
                    </div>
                    <Badge status={post.status} />
                    {post.externalPostUrl && (
                      <a
                        href={post.externalPostUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg p-1.5 text-ink-3 hover:text-accent"
                        aria-label="Open published post"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    {post.status === "PENDING" && (
                      <button
                        onClick={() => cancelMutation.mutate(post.id)}
                        className="rounded-lg p-1.5 text-ink-3 hover:text-red-500"
                        aria-label="Cancel"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    )}
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
