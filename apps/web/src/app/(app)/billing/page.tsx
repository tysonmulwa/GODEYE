"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, ExternalLink, Lock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceAccess } from "@godeye/shared";
import { PayMethods, type PaymentMethod } from "@/components/pay-methods";
import { PayOnPhone } from "@/components/pay-qr";
import { ApplePayMark, Badge, Button, Card, ErrorNote, PageHeader } from "@/components/ui";
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
  /** One month on M-Pesa, in shillings. Shown only once M-Pesa is chosen. */
  priceMpesaKes: number;
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
  /** Ways to pay this server offers, in the order the picker shows them. */
  methods: string[];
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

/**
 * A price in the currency it is actually charged in.
 *
 * The card subscription is quoted in dollars and the wallet month in shillings,
 * because those are the two currencies Paystack bills. Showing one converted
 * into the other would put a number on this page that appears on nobody's
 * statement.
 */
function money(currency: string, major: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(major);
}

/** "23 hours" or "45 minutes", the same wording the trial strip uses. */
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
  /** The plan whose payment picker is open, if any. */
  const [choosing, setChoosing] = useState<PlanRow | null>(null);
  /** The open scan-to-pay dialog, if any. */
  const [payOnPhone, setPayOnPhone] = useState<{
    url: string;
    planCode: string;
    // Never a card: a card is paid on the device the customer is already
    // using, so there is nothing to hand to a phone.
    method: Exclude<PaymentMethod, "card">;
  } | null>(null);
  /** What billing looked like when it opened, so a change means "paid". */
  const [before, setBefore] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Overview>({
    queryKey: ["billing"],
    queryFn: () => api<Overview>("/billing"),
    // Paystack sends the customer back here the moment they pay, and the
    // webhook that activates the plan can land a second or two later.
    refetchOnMount: "always",
  });

  const checkout = useMutation({
    mutationFn: ({ planCode, method }: { planCode: string; method: PaymentMethod }) =>
      // The body is the object itself. api() serialises it, and passing a
      // string here stringified it twice, so the API received a quoted blob
      // instead of a plan code and every upgrade failed validation.
      api<{ url: string; reference: string | null }>("/billing/checkout", {
        method: "POST",
        body: { planCode, method },
      }),
    onSuccess: ({ url }, { planCode, method }) => {
      setChoosing(null);
      // A card is paid on this device, which has one. A wallet lives on a
      // phone that is not this screen, so those get the QR.
      if (method === "card") {
        window.location.href = url;
        return;
      }
      setPayOnPhone({ url, planCode, method });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start checkout"),
  });

  /**
   * Confirm the payment the customer has just come back from.
   *
   * Paystack puts the reference on the return URL, so the page can ask the API
   * to check it and activate the plan there and then. The webhook does the same
   * job and usually wins the race, but it is one server calling another and it
   * can be unconfigured or slow, which is exactly the case where the customer
   * is staring at the old plan wondering where their money went.
   */
  const confirm = useMutation({
    mutationFn: (reference: string) =>
      api<{ applied: boolean; status: string }>("/billing/verify", {
        method: "POST",
        body: { reference },
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["billing"] }),
  });

  const banner = params.get("billing");

  /**
   * A fingerprint of what has been paid for.
   *
   * The webhook is what actually grants the month, and it arrives on its own a
   * second or two after the customer confirms on their phone. Rather than ask
   * Paystack whether that particular reference succeeded, which would need its
   * own idempotency, since crediting a month twice for one payment is worse
   * than waiting, the page simply watches for its own billing state to change.
   */
  const paidFingerprint = data
    ? `${data.plan.code}|${data.subscriptionStatus}|${data.currentPeriodEnd}`
    : null;

  // Snapshot on open; anything different afterwards is the payment landing.
  useEffect(() => {
    if (payOnPhone && before === null && paidFingerprint) setBefore(paidFingerprint);
    if (!payOnPhone && before !== null) setBefore(null);
  }, [payOnPhone, before, paidFingerprint]);

  const paidOnPhone = !!payOnPhone && before !== null && paidFingerprint !== before;

  // Poll only while somebody is standing in front of the QR, and stop the
  // moment the payment shows up, since a success dialog has nothing left to
  // wait for.
  useEffect(() => {
    if (!payOnPhone || paidOnPhone) return;
    const id = setInterval(
      () => void queryClient.invalidateQueries({ queryKey: ["billing"] }),
      4000,
    );
    return () => clearInterval(id);
  }, [payOnPhone, paidOnPhone, queryClient]);

  // Keep the rest of the app in step: paying here is what lifts the read-only
  // state, and the sidebar strip should stop warning about a trial that is over.
  useEffect(() => {
    if (data?.access) setAccess(data.access);
  }, [data?.access, setAccess]);

  // Straight back from Paystack: confirm the reference on the URL, once.
  const reference = params.get("reference") ?? params.get("trxref");
  const confirmRef = useRef<string | null>(null);
  useEffect(() => {
    if (banner !== "success" || !reference) return;
    if (confirmRef.current === reference) return;
    confirmRef.current = reference;
    confirm.mutate(reference);
  }, [banner, reference, confirm]);

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
          Payment received. Your new plan is active, it can take a few seconds to appear here.
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
                      : `Free trial, ${trialRemaining(data.access.trialEndsAt)} left`}
                  </h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                    {data.access.locked
                      ? "Your free trial has ended, so publishing, generating and editing are paused. Everything you have made is still here. Choosing a plan below turns it all back on straight away."
                      : "Everything is switched on until then, publishing included. Choose a plan before the clock runs out and nothing pauses."}
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
              // with no way to actually buy it, only the two dearer tiers.
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
                      disabled={!data.paymentsConfigured}
                      onClick={() => {
                        setError(null);
                        setChoosing(p);
                      }}
                    >
                      {paying ? `Switch to ${p.name}` : "Subscribe"}
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

          {choosing && (
            <PayMethods
              planName={choosing.name}
              priceUsd={usd.format(Number(choosing.priceMonthlyUsd))}
              priceMpesaKes={choosing.priceMpesaKes}
              methods={data.methods}
              busy={checkout.isPending ? (checkout.variables?.method ?? null) : null}
              onPick={(method) => {
                setError(null);
                checkout.mutate({ planCode: choosing.code, method });
              }}
              onClose={() => setChoosing(null)}
            />
          )}

          {payOnPhone &&
            (() => {
              const plan = data.plans.find((p) => p.code === payOnPhone.planCode);
              return (
                <PayOnPhone
                  url={payOnPhone.url}
                  planName={plan?.name ?? payOnPhone.planCode}
                  price={
                    plan
                      ? payOnPhone.method === "mpesa"
                        ? money("KES", plan.priceMpesaKes)
                        : usd.format(Number(plan.priceMonthlyUsd))
                      : ""
                  }
                  method={payOnPhone.method}
                  paid={paidOnPhone}
                  onClose={() => setPayOnPhone(null)}
                />
              );
            })()}

        </>
      )}
    </>
  );
}
