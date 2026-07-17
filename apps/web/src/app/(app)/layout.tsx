"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  CalendarDays,
  Eye,
  Gauge,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  PenSquare,
  Rocket,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cx } from "@/components/ui";
import { api, API_URL } from "@/lib/api";
import { useAuthStore, type SessionOrg, type SessionUser } from "@/lib/auth-store";
import { useRealtime } from "@/lib/socket";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/composer", label: "Composer", icon: PenSquare },
  { href: "/autopilot", label: "Autopilot", icon: Rocket },
  { href: "/seo", label: "SEO", icon: Gauge },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/connections", label: "Connections", icon: Link2 },
  { href: "/team", label: "Team", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

interface OrgMembershipRow {
  orgId: string;
  name: string;
  slug: string;
  role: string;
}

/** Dropdown shown only when the user belongs to more than one organization. */
function OrgSwitcher() {
  const queryClient = useQueryClient();
  const { organization, setSession } = useAuthStore();
  const { data: orgs } = useQuery({
    queryKey: ["auth", "orgs"],
    queryFn: () => api<OrgMembershipRow[]>("/auth/orgs"),
    staleTime: 60_000,
  });

  if (!orgs || orgs.length < 2 || !organization) {
    return <p className="truncate text-[11px] text-ink-3">{organization?.name}</p>;
  }

  const switchOrg = async (orgId: string) => {
    if (orgId === organization.id) return;
    const session = await api<{ user: SessionUser; organization: SessionOrg; accessToken: string }>(
      "/auth/switch-org",
      { method: "POST", body: { orgId } },
    );
    setSession(session);
    queryClient.clear();
  };

  return (
    <select
      value={organization.id}
      onChange={(e) => void switchOrg(e.target.value)}
      className="mt-0.5 w-full truncate rounded border border-transparent bg-transparent text-[11px] text-ink-3 hover:border-line focus:outline-none"
      title="Switch organization"
    >
      {orgs.map((o) => (
        <option key={o.orgId} value={o.orgId}>
          {o.name} · {o.role.toLowerCase()}
        </option>
      ))}
    </select>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, user, organization, clear } = useAuthStore();
  useRealtime();

  useEffect(() => {
    if (status === "guest") router.replace("/login");
    if (status === "authed" && organization && !organization.hasProfile) {
      router.replace("/onboarding");
    }
  }, [status, organization, router]);

  if (status !== "authed") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </div>
    );
  }

  const logout = async () => {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    clear();
    router.replace("/login");
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-2">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white">
            <Eye className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">GODEYE</span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  active
                    ? "bg-surface-3 font-medium text-ink"
                    : "text-ink-2 hover:bg-surface-3 hover:text-ink",
                )}
              >
                <Icon className={cx("h-4 w-4", active ? "text-accent" : "")} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{user?.name}</p>
              <OrgSwitcher />
            </div>
            <ThemeToggle />
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="mx-auto max-w-5xl px-8 py-8"
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
