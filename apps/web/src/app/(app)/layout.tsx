"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  CalendarDays,
  Gauge,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  PenSquare,
  Rocket,
  Search,
  Settings,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { GodeyeBootScreen, GodeyeLockup } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { cx } from "@/components/ui";
import { api, AUTH_URL } from "@/lib/api";
import { useAuthStore, type SessionOrg, type SessionUser } from "@/lib/auth-store";
import { useScrollLock } from "@/lib/use-scroll-lock";
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
    <p className="truncate font-mono text-[12px] text-ink-3">
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
      className="w-full truncate rounded border border-transparent bg-transparent font-mono text-[12px] text-ink-3 hover:border-line focus:outline-none"
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
  const [navOpen, setNavOpen] = useState(false);
  useRealtime();

  useEffect(() => {
    if (status === "guest") router.replace("/login");
    if (status === "authed" && organization && !organization.hasProfile) {
      router.replace("/onboarding");
    }
  }, [status, organization, router]);

  // Navigating on a phone should dismiss the drawer, not leave it covering the page.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Now that the document scrolls on phones, an open drawer would otherwise let
  // the page slide around underneath it.
  useScrollLock(navOpen);

  if (status !== "authed") {
    return (
      <GodeyeBootScreen />
    );
  }

  const logout = async () => {
    await fetch(`${AUTH_URL}/auth/logout`, { method: "POST", credentials: "include" });
    clear();
    router.replace("/login");
  };

  // Below lg the document scrolls; from lg up the shell is pinned and <main>
  // scrolls inside it. A fixed dvh shell on a phone is re-measured every frame
  // as the address bar collapses, so the page changes height while you scroll
  // it — which is the shakiness itself. svh is the stable floor: it is the
  // viewport with browser chrome showing, and it never changes.
  return (
    <div className="flex min-h-svh lg:h-dvh lg:overflow-hidden">
      {/* Dim + dismiss layer behind the mobile drawer */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
        />
      )}

      {/* Off-canvas below lg, static column from lg up */}
      <aside
        className={cx(
          "glass-strong fixed inset-y-0 left-0 z-50 flex w-[236px] shrink-0 flex-col rounded-none border-y-0 border-l-0 transition-transform duration-200 lg:static lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-4">
          <GodeyeLockup />
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
            className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("godeye:open-search"))}
            className="flex h-[34px] w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 transition-colors hover:border-line-hover"
          >
            <Search className="h-3.5 w-3.5 text-ink-3" />
            <span className="flex-1 text-left text-[14px] text-ink-3">Search</span>
            <kbd className="rounded border border-line bg-surface-3 px-1 text-[12px] text-ink-3">⌘K</kbd>
          </button>
        </div>

        <p className="px-4 pb-1 pt-4 font-mono text-[12px] font-semibold uppercase tracking-[0.11em] text-ink-4">
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
                  "relative flex items-center gap-2.5 rounded-lg px-[11px] py-2 text-[14px] transition-colors",
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
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] bg-ink font-mono text-[14px] font-semibold text-surface-2">
              {initials(user?.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">{user?.name}</p>
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

      {/* min-w-0 lets flex children shrink; without it wide content forces the
          whole page to scroll sideways on a phone. */}
      <main className="flex min-w-0 flex-1 flex-col lg:overflow-y-auto">
        {/* Phone-only top bar — the only way to reach the nav below lg.
            Opaque, not translucent: a backdrop-blur on a sticky bar is
            re-composited on every scroll frame, which is visible stutter on a
            mid-range phone and buys nothing the solid fill doesn't. */}
        <header className="glass-strong sticky top-0 z-30 flex items-center gap-2 rounded-none border-x-0 border-t-0 px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
          >
            <Menu className="h-5 w-5" />
          </button>
          <GodeyeLockup />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("godeye:open-search"))}
            aria-label="Search"
            className="ml-auto rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
          >
            <Search className="h-4 w-4" />
          </button>
        </header>

        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className={cx(
            "w-full min-w-0 px-4 pb-8 pt-5 sm:px-6 lg:px-7 lg:pt-6",
            pathname.startsWith("/calendar") ? "" : "mx-auto max-w-[1024px]",
          )}
        >
          {children}
        </motion.div>
      </main>

      <CommandPalette items={NAV} />
    </div>
  );
}
