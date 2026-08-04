"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ExternalLink } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, ErrorNote, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";

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
  limits: PlanLimits;
  usage: PlanLimits;
  plans: PlanRow[];
  stripeConfigured: boolean;
}

/**
 * Prices are held in the database as USD and shown as USD everywhere. GODEYE
 * sells internationally and Stripe settles in the currency of the Price
 * object, so quoting a local figure on this page would be a number the
 * customer never actually gets charged.
 */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

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
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Overview>({
    queryKey: ["billing"],
    queryFn: () => api<Overview>("/billing"),
  });

  const checkout = useMutation({
    mutationFn: (planCode: string) =>
      api<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planCode }),
      }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start checkout"),
  });

  const banner = params.get("billing");

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
              const current = p.code === data.plan.code;
              const paid = p.code !== "FREE";
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
                  {paid && !current && (
                    <Button
                      className="mt-5 w-full"
                      loading={checkout.isPending}
                      disabled={!data.stripeConfigured}
                      onClick={() => {
                        setError(null);
                        checkout.mutate(p.code);
                      }}
                    >
                      Upgrade to {p.name}
                    </Button>
                  )}
                </Card>
              );
            })}
          </div>

          {!data.stripeConfigured && (
            <p className="mt-4 text-xs text-ink-3">
              Payments are not configured on this server yet, so upgrading is unavailable.
            </p>
          )}

          <p className="mt-6 flex items-center gap-1.5 text-xs text-ink-3">
            <ExternalLink size={12} />
            Payments are handled by Stripe. GODEYE never sees or stores your card details.
          </p>
        </>
      )}
    </>
  );
}
