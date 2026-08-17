"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, ExternalLink, Lock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { WorkspaceAccess } from "@godeye/shared";
import { Badge, Button, Card, ErrorNote, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";

interface PlanLimits {
  postsPerMonth: number;
  aiTokensPerMonth: number;
  connections: number;
  seats: number;
}

interface PlanRow {
  code: string;
  name: string;
  priceMonthlyUsd: string;
  limits: PlanLimits;
}

interface Overview {
  plan: { code: string; name: string; priceMonthlyUsd: string };
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  /** The trial clock and read-only state, exactly as the API enforces them. */
  access: WorkspaceAccess;
  limits: PlanLimits;
  usage: PlanLimits;
  plans: PlanRow[];
  /** True when Paystack is live on this server. False hides the upgrade
   *  buttons rather than sending somebody to a checkout that cannot start. */
  paymentsConfigured: boolean;
}

/**
 * Prices are held in the database as USD and shown as USD everywhere. GODEYE
 * sells internationally and Paystack settles in the currency of the plan, so
 * quoting a local figure on this page would be a number the customer never
 * actually gets charged.
 */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

/** "23 hours", "45 minutes" — the same wording the trial strip uses. */
function trialRemaining(endsAt: string | null): string {
  const ms = endsAt ? Date.parse(endsAt) - Date.now() : 0;
  if (!Number.isFinite(ms) || ms <= 0) return "no time";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

const METRICS: { key: keyof PlanLimits; label: string; format: (n: number) => string }[] = [
  { key: "postsPerMonth", label: "Posts this month", format: (n) => n.toLocaleString("en-US") },
  { key: "aiTokensPerMonth", label: "AI tokens", format: (n) => compact.format(n) },
  { key: "connections", label: "Connected channels", format: (n) => String(n) },
  { key: "seats", label: "Seats", format: (n) => String(n) },
];

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  // Amber before the wall, not at it: a customer who only learns at 100% has
  // already had a post refused.
  const tone =
    pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-accent";
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-1/10">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function BillingPage() {
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const setAccess = useAuthStore((s) => s.setAccess);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Overview>({
    queryKey: ["billing"],
    queryFn: () => api<Overview>("/billing"),
    // Paystack sends the customer back here the moment they pay, and the
    // webhook that activates the plan can land a second or two later.
    refetchOnMount: "always",
  });

  const checkout = useMutation({
    mutationFn: (planCode: string) =>
      // The body is the object itself. api() serialises it — passing a string
      // here stringified it twice, and the API received a quoted blob instead
      // of a plan code, so every upgrade failed validation.
      api<{ url: string }>("/billing/checkout", { method: "POST", body: { planCode } }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start checkout"),
  });

  const banner = params.get("billing");

  // Keep the rest of the app in step: paying here is what lifts the read-only
  // state, and the sidebar strip should stop warning about a trial that is over.
  useEffect(() => {
    if (data?.access) setAccess(data.access);
  }, [data?.access, setAccess]);

  // A successful return from Paystack races the webhook. One retry a few
  // seconds later turns "still says trial" into "says Premium" without the
  // customer having to reload the page and wonder.
  useEffect(() => {
    if (banner !== "success") return;
    const id = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["billing"] }), 4000);
    return () => clearTimeout(id);
  }, [banner, queryClient]);

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle={
          data ? (
            <span>
              <span className="font-mono">{data.plan.name}</span>
              <span> · </span>
              <span className="font-mono">{usd.format(Number(data.plan.priceMonthlyUsd))}</span>
              <span>/month</span>
              {data.currentPeriodEnd && (
                <span>
                  {" · renews "}
                  {new Date(data.currentPeriodEnd).toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              )}
            </span>
          ) : (
            "Plans, usage and payment"
          )
        }
      />

      {banner === "success" && (
        <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
          Payment received. Your new plan is active — it can take a few seconds to appear here.
        </p>
      )}
      {banner === "cancelled" && (
        <p className="mb-4 rounded-lg border border-line bg-ink-1/5 px-3 py-2 text-sm text-ink-2">
          Checkout cancelled. Nothing was charged.
        </p>
      )}

      <ErrorNote message={error} />

      {isLoading && <p className="text-sm text-ink-3">Loading…</p>}

      {data && (
        <>
          {(data.access.status === "TRIALING" || data.access.locked) && (
            <Card
              className={`mb-6 ${
                data.access.locked ? "border-red-500/30 bg-red-500/5" : "border-accent/30"
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    data.access.locked
                      ? "bg-red-500/10 text-red-600 dark:text-red-400"
                      : "bg-accent-soft text-accent"
                  }`}
                >
                  {data.access.locked ? <Lock size={15} /> : <Clock size={15} />}
                </span>
                <div>
                  <h2 className="text-sm font-semibold">
                    {data.access.locked
                      ? "This workspace is read-only"
                      : `Free trial — ${trialRemaining(data.access.trialEndsAt)} left`}
                  </h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                    {data.access.locked
                      ? "Your free trial has ended, so publishing, generating and editing are paused. Everything you have made is still here. Choosing a plan below turns it all back on straight away."
                      : "Everything is switched on until then — publishing included. Choose a plan before the clock runs out and nothing pauses."}
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card className="mb-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">This month</h2>
              {data.subscriptionStatus && (
                <Badge status={data.subscriptionStatus} />
              )}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {METRICS.map((m) => {
                const used = data.usage[m.key];
                const limit = data.limits[m.key];
                return (
                  <div key={m.key}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-ink-3">{m.label}</span>
                      <span className="font-mono text-xs">
                        {m.format(used)}
                        <span className="text-ink-3"> / {m.format(limit)}</span>
                      </span>
                    </div>
                    <UsageBar used={used} limit={limit} />
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            {data.plans.map((p) => {
              // A trial runs on the Pro plan, so matching on the plan code
              // alone marked Pro as "current" and left a trialing workspace
              // with no way to actually buy it — only the two dearer tiers.
              // Nothing is current until something has been paid for.
              const paying = data.access.status === "ACTIVE" || data.access.status === "EXEMPT";
              const current = paying && p.code === data.plan.code;
              return (
                <Card key={p.code} className={current ? "ring-1 ring-accent" : undefined}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{p.name}</h3>
                    {current && <Badge status="CURRENT" />}
                  </div>
                  <p className="mt-3">
                    <span className="font-mono text-2xl font-bold">
                      {usd.format(Number(p.priceMonthlyUsd))}
                    </span>
                    <span className="text-sm text-ink-3">/month</span>
                  </p>
                  <ul className="mt-4 space-y-2 text-sm">
                    {METRICS.map((m) => (
                      <li key={m.key} className="flex items-start gap-2">
                        <Check size={15} className="mt-0.5 shrink-0 text-accent" />
                        <span>
                          <span className="font-mono">{m.format(p.limits[m.key])}</span>{" "}
                          <span className="text-ink-2">{m.label.toLowerCase()}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!current && (
                    <Button
                      className="mt-5 w-full"
                      loading={checkout.isPending}
                      disabled={!data.paymentsConfigured}
                      onClick={() => {
                        setError(null);
                        checkout.mutate(p.code);
                      }}
                    >
                      {paying ? `Switch to ${p.name}` : `Choose ${p.name}`}
                    </Button>
                  )}
                </Card>
              );
            })}
          </div>

          {!data.paymentsConfigured && (
            <p className="mt-4 text-xs text-ink-3">
              Payments are not configured on this server yet, so upgrading is unavailable.
            </p>
          )}

          <p className="mt-6 flex items-center gap-1.5 text-xs text-ink-3">
            <ExternalLink size={12} />
            Payments are handled by Paystack — card, mobile money and Apple Pay. GODEYE never sees
            or stores your card details.
          </p>
        </>
      )}
    </>
  );
}
