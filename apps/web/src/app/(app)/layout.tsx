"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  CalendarDays,
  Gauge,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  PenSquare,
  Rocket,
  Search,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { GodeyeLockup } from "@/components/logo";
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

function initials(name: string | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
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

  const roleLine = (
    <p className="truncate font-mono text-[10.5px] text-ink-3">
      role:{(organization?.role ?? "").toLowerCase()}
    </p>
  );

  if (!orgs || orgs.length < 2 || !organization) return roleLine;

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
      className="w-full truncate rounded border border-transparent bg-transparent font-mono text-[10.5px] text-ink-3 hover:border-line focus:outline-none"
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
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-line-soft bg-sidebar">
        <div className="border-b border-line-soft px-4 py-4">
          <GodeyeLockup />
        </div>

        <div className="px-3 pt-3">
          <div className="flex h-[34px] items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5">
            <Search className="h-3.5 w-3.5 text-ink-3" />
            <span className="flex-1 text-[12.5px] text-ink-3">Search</span>
            <kbd className="rounded border border-line bg-surface-3 px-1 font-mono text-[9.5px] text-ink-3">
              ⌘K
            </kbd>
          </div>
        </div>

        <p className="px-4 pb-1 pt-4 font-mono text-[10px] font-semibold uppercase tracking-[0.11em] text-ink-4">
          Workspace
        </p>
        <nav className="flex-1 space-y-0.5 px-2 py-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cx(
                  "relative flex items-center gap-2.5 rounded-lg px-[11px] py-2 text-[13.5px] transition-colors",
                  active
                    ? "bg-accent-soft font-semibold text-accent-hover"
                    : "text-ink-2 hover:bg-surface-3 hover:text-ink",
                )}
              >
                {active && (
                  <span className="absolute -left-2 bottom-[7px] top-[7px] w-[2.5px] rounded-r bg-accent" />
                )}
                <Icon className={cx("h-4 w-4", active ? "text-accent" : "")} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line-soft p-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] bg-ink font-mono text-[11px] font-semibold text-surface-2">
              {initials(user?.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-semibold">{user?.name}</p>
              <OrgSwitcher />
            </div>
            <ThemeToggle />
            <button
              onClick={logout}
              aria-label="Sign out"
              className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className={cx(
            "px-7 pb-8 pt-6",
            pathname.startsWith("/calendar") ? "" : "mx-auto max-w-[1024px]",
          )}
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
