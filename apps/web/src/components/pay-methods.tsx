"use client";

import { X } from "lucide-react";
import { ApplePayMark, CardsMark, MpesaGlyph, MpesaMark } from "@/components/payment-marks";
import { cx } from "@/components/ui";
import { useScrollLock } from "@/lib/use-scroll-lock";

export type PaymentMethod = "card" | "apple_pay" | "mpesa";

/**
 * How would you like to pay?
 *
 * One question, asked once, after the customer has already chosen a plan. The
 * plan cards say what the plan costs and nothing about payment, because a
 * shilling figure next to a dollar figure makes somebody stop and work out
 * which one applies to them.
 *
 * A card is the only method Paystack can charge again, so it is the only one
 * that subscribes. The wallets buy a month at a time. That difference is worth
 * exactly one short line under the card option, not a paragraph.
 */
const LABELS: Record<
  PaymentMethod,
  { title: React.ReactNode; hint: string; icon: React.ReactNode }
> = {
  card: {
    title: <span className="text-[14px] font-semibold">Card</span>,
    hint: "Renews automatically every month",
    icon: <CardsMark size={18} />,
  },
  apple_pay: {
    title: <ApplePayMark size={14} />,
    hint: "Pay for one month",
    icon: <ApplePayMark size={11} boxed />,
  },
  mpesa: {
    title: <MpesaMark size={14} />,
    hint: "Pay for one month",
    icon: <MpesaGlyph size={18} />,
  },
};

export function PayMethods({
  planName,
  priceUsd,
  priceMpesaKes,
  methods,
  busy,
  onPick,
  onClose,
}: {
  planName: string;
  priceUsd: string;
  priceMpesaKes: number;
  methods: string[];
  busy: PaymentMethod | null;
  onPick: (method: PaymentMethod) => void;
  onClose: () => void;
}) {
  useScrollLock(true);

  const order: PaymentMethod[] = ["card", "apple_pay", "mpesa"];
  const available = order.filter((m) => methods.includes(m));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Pay for ${planName}`}
      className="fixed inset-0 z-60 flex items-center justify-center bg-ink/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-surface-2 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[17px] font-semibold leading-snug">Subscribe to {planName}</h2>
            <p className="mt-0.5 text-[13px] text-ink-3">
              <span className="font-mono">{priceUsd}</span> a month
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-2">
          {available.map((method) => {
            const { title, hint, icon } = LABELS[method];
            return (
              <button
                key={method}
                type="button"
                disabled={!!busy}
                onClick={() => onPick(method)}
                className={cx(
                  "flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors",
                  busy === method
                    ? "border-accent bg-accent-soft"
                    : "border-line hover:border-line-hover hover:bg-surface-3",
                  busy && busy !== method ? "opacity-50" : "",
                )}
              >
                <span className="shrink-0 text-ink-3">{icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block">{title}</span>
                  <span className="block text-[12px] text-ink-3">
                    {/* Shillings appear here and nowhere else, and only once
                        M-Pesa is on screen as the thing being chosen. */}
                    {method === "mpesa"
                      ? `KES ${priceMpesaKes.toLocaleString("en-US")} for one month`
                      : hint}
                  </span>
                </span>
                {busy === method && (
                  <span className="shrink-0 text-[12px] text-accent">Opening</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
