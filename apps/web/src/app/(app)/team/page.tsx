"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Label,
  PageHeader,
} from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";

interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

interface MembersResponse {
  members: MemberRow[];
  invitations: InvitationRow[];
}

interface InviteResult {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  inviteUrl: string;
}

const ROLE_RANK: Record<string, number> = { OWNER: 4, ADMIN: 3, EDITOR: 2, VIEWER: 1 };
const ASSIGNABLE = ["ADMIN", "EDITOR", "VIEWER"] as const;

const ROLE_HINTS: Record<string, string> = {
  ADMIN: "Manage team, approve content, everything except deleting the org",
  EDITOR: "Create, edit and schedule content",
  VIEWER: "Read-only access to dashboards and content",
};

export default function TeamPage() {
  const queryClient = useQueryClient();
  const { user, organization } = useAuthStore();
  const myRole = organization?.role ?? "VIEWER";
  const myRank = ROLE_RANK[myRole] ?? 0;
  const canManage = myRank >= ROLE_RANK.ADMIN;

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ASSIGNABLE)[number]>("EDITOR");
  const [error, setError] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["members"],
    queryFn: () => api<MembersResponse>("/members"),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members"] });

  const invite = useMutation({
    mutationFn: () =>
      api<InviteResult>("/members/invitations", { method: "POST", body: { email, role } }),
    onSuccess: (result) => {
      setLastInvite(result);
      setCopied(false);
      setEmail("");
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Invite failed"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/members/invitations/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Revoke failed"),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role: newRole }: { userId: string; role: string }) =>
      api(`/members/${userId}`, { method: "PATCH", body: { role: newRole } }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Role change failed"),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api(`/members/${userId}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : "Remove failed"),
  });

  const copyInviteUrl = async () => {
    if (!lastInvite) return;
    await navigator.clipboard.writeText(lastInvite.inviteUrl);
    setCopied(true);
  };

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={
          <span>
            {data?.members.length ?? 0} member{(data?.members.length ?? 0) === 1 ? "" : "s"}
            {(data?.invitations.length ?? 0) > 0 && (
              <span className="text-amber-600"> · {data!.invitations.length} pending</span>
            )}
          </span>
        }
      />
      <div className="space-y-5">
        <ErrorNote message={error} />

        {canManage && (
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Invite a teammate</h2>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              <div className="min-w-56 flex-1">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="invite-role">Role</Label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as (typeof ASSIGNABLE)[number])}
                  className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                >
                  {ASSIGNABLE.filter((r) => ROLE_RANK[r] < myRank).map((r) => (
                    <option key={r} value={r}>
                      {r.charAt(0) + r.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" loading={invite.isPending}>
                <UserPlus className="h-4 w-4" /> Invite
              </Button>
            </form>
            <p className="mt-2 text-xs text-ink-3">{ROLE_HINTS[role]}</p>

            {lastInvite && (
              <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
                <p className="text-xs font-medium">
                  Invite link for {lastInvite.email} — share it now, it is only shown once:
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-surface-3 px-2 py-1.5 text-[11px]">
                    {lastInvite.inviteUrl}
                  </code>
                  <Button variant="secondary" onClick={() => void copyInviteUrl()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-ink-3">
                  Expires {new Date(lastInvite.expiresAt).toLocaleDateString()}
                </p>
              </div>
            )}
          </Card>
        )}

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Members</h2>
          {isLoading ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : (
            <ul className="divide-y divide-line">
              {(data?.members ?? []).map((m) => {
                const isSelf = m.userId === user?.id;
                const canEdit = canManage && !isSelf && ROLE_RANK[m.role] < myRank;
                const initials =
                  m.name
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((p) => p[0])
                    .join("")
                    .toUpperCase() || "?";
                return (
                  <li key={m.userId} className="flex items-center gap-3 py-3">
                    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-ink font-mono text-[11px] font-semibold text-surface-2">
                      {initials}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {m.name}
                        {isSelf && (
                          <span className="ml-1.5 font-mono text-[10.5px] text-ink-4">you</span>
                        )}
                      </p>
                      <p className="truncate font-mono text-[10.5px] text-ink-3">{m.email}</p>
                    </div>
                    {canEdit ? (
                      <select
                        value={m.role}
                        onChange={(e) =>
                          changeRole.mutate({ userId: m.userId, role: e.target.value })
                        }
                        className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
                      >
                        {ASSIGNABLE.filter((r) => ROLE_RANK[r] < myRank).map((r) => (
                          <option key={r} value={r}>
                            {r.charAt(0) + r.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge status={m.role} />
                    )}
                    {canEdit && (
                      <button
                        title="Remove from organization"
                        onClick={() => {
                          if (confirm(`Remove ${m.name} from the organization?`)) {
                            remove.mutate(m.userId);
                          }
                        }}
                        className="rounded p-1.5 text-ink-3 transition-colors hover:bg-red-500/10 hover:text-red-500"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {canManage && (data?.invitations.length ?? 0) > 0 && (
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Pending invitations</h2>
            <ul className="divide-y divide-line">
              {data!.invitations.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{i.email}</p>
                    <p className="text-xs text-ink-3">
                      {i.invitedByName ? `Invited by ${i.invitedByName} · ` : ""}
                      expires {new Date(i.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge status={i.role} />
                  <Button
                    variant="ghost"
                    onClick={() => revoke.mutate(i.id)}
                    loading={revoke.isPending}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {!canManage && !isLoading && (data?.members.length ?? 0) <= 1 && (
          <EmptyState
            title="No teammates yet"
            hint="Ask an admin or the owner to invite people to this organization."
          />
        )}
      </div>
    </>
  );
}
