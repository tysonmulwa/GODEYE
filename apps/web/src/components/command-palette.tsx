"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Link2, Rocket, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cx } from "@/components/ui";

export interface CommandItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface Result {
  key: string;
  label: string;
  sublabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  section: string;
}

interface Connection {
  id: string;
  platform: string;
  displayName: string;
  status: string;
}
interface ScheduledPost {
  id: string;
  contentPreview: string;
  platform: string;
  connectionName: string;
}
interface Plan {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Global quick-search / command palette. Opens on ⌘K / Ctrl+K (or a
 * `godeye:open-search` event). Searches the app's pages plus live data —
 * connected channels, scheduled posts, and autopilot plans — and navigates to
 * the relevant page on Enter/click. Esc or a backdrop click closes it.
 */
export function CommandPalette({ items }: { items: CommandItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch once the palette is opened; reuses any cache the pages already filled.
  const { data: connections = [] } = useQuery<Connection[]>({
    queryKey: ["connections"],
    queryFn: () => api("/connections"),
    enabled: open,
    staleTime: 30_000,
  });
  const { data: posts = [] } = useQuery<ScheduledPost[]>({
    queryKey: ["schedule"],
    queryFn: () => api("/schedule"),
    enabled: open,
    staleTime: 30_000,
  });
  const { data: plans = [] } = useQuery<Plan[]>({
    queryKey: ["posting-plans"],
    queryFn: () => api("/posting-plans"),
    enabled: open,
    staleTime: 30_000,
  });

  const q = query.trim().toLowerCase();

  const results = useMemo<Result[]>(() => {
    const pages: Result[] = items.map((i) => ({
      key: `page:${i.href}`,
      label: i.label,
      icon: i.icon,
      href: i.href,
      section: "Pages",
    }));

    // With no query, keep it to pages so the palette stays a fast page-jumper.
    if (!q) return pages;

    const match = (s: string) => s.toLowerCase().includes(q);

    const channelResults: Result[] = connections
      .filter((c) => match(c.displayName) || match(c.platform))
      .map((c) => ({
        key: `conn:${c.id}`,
        label: c.displayName,
        sublabel: `${c.platform.toLowerCase()} · ${c.status.toLowerCase()}`,
        icon: Link2,
        href: "/connections",
        section: "Channels",
      }));

    const postResults: Result[] = posts
      .filter((p) => match(p.contentPreview) || match(p.platform) || match(p.connectionName))
      .slice(0, 8)
      .map((p) => ({
        key: `post:${p.id}`,
        label: p.contentPreview || "(no preview)",
        sublabel: `${p.platform.toLowerCase()} · ${p.connectionName}`,
        icon: CalendarDays,
        href: "/calendar",
        section: "Scheduled posts",
      }));

    const planResults: Result[] = plans
      .filter((p) => match(p.name))
      .map((p) => ({
        key: `plan:${p.id}`,
        label: p.name,
        sublabel: p.active ? "active" : "paused",
        icon: Rocket,
        href: "/autopilot",
        section: "Autopilot plans",
      }));

    return [
      ...pages.filter((p) => match(p.label)),
      ...channelResults,
      ...postResults,
      ...planResults,
    ];
  }, [items, q, connections, posts, plans]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("godeye:open-search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("godeye:open-search", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  // Render grouped by section while keeping a single flat index for keyboard nav.
  let runningIndex = -1;
  const sections = Array.from(new Set(results.map((r) => r.section)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface-2 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
          <Search className="h-4 w-4 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && results[active]) {
                go(results[active].href);
              }
            }}
            placeholder="Search pages, channels, posts, plans…"
            className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <kbd className="rounded border border-line bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-3">
            esc
          </kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li className="px-3 py-3 text-[13px] text-ink-3">No matches for “{query}”.</li>
          ) : (
            sections.map((section) => (
              <li key={section}>
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
                  {section}
                </p>
                <ul>
                  {results
                    .filter((r) => r.section === section)
                    .map((item) => {
                      runningIndex += 1;
                      const idx = runningIndex;
                      const Icon = item.icon;
                      return (
                        <li key={item.key}>
                          <button
                            onMouseEnter={() => setActive(idx)}
                            onClick={() => go(item.href)}
                            className={cx(
                              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
                              idx === active ? "bg-accent-soft text-accent-hover" : "text-ink-2",
                            )}
                          >
                            <Icon
                              className={cx(
                                "h-4 w-4 shrink-0",
                                idx === active ? "text-accent" : "text-ink-3",
                              )}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13.5px]">{item.label}</span>
                              {item.sublabel && (
                                <span className="block truncate text-[12px] text-ink-4">
                                  {item.sublabel}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
