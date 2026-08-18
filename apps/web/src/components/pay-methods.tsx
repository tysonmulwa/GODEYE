"use client";

import { X } from "lucide-react";
import { ApplePayMark, CardsMark, MpesaMark } from "@/components/payment-marks";
import { cx } from "@/components/ui";
import { useScrollLock } from "@/lib/use-scroll-lock";

export type PaymentMethod = "card" | "apple_pay" | "mpesa";

/**
 * Whether this device can raise the Apple Pay sheet itself.
 *
 * Safari on an iPhone, iPad or Mac exposes ApplePaySession, and no other
 * browser does. Where it exists the customer taps and confirms with Face ID,
 * so a QR code would be a step that achieves nothing. Where it does not, the QR
 * is the only way to reach the wallet they own, which lives on a device that is
 * not this screen.
 */
export function applePayIsNative(): boolean {
  if (typeof window === "undefined") return false;
  const session = (window as unknown as { ApplePaySession?: { canMakePayments?: () => boolean } })
    .ApplePaySession;
  try {
    return !!session?.canMakePayments?.();
  } catch {
    // Some browsers throw on canMakePayments in an insecure context.
    return false;
  }
}

/** A phone or tablet, where showing a QR to scan with that same device is absurd. */
export function isHandheld(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/**
 * How would you like to pay?
 *
 * Asked once, after the plan is chosen, which leaves the plan cards free to
 * talk about the plan. Each row carries its own brand mark, one line of
 * description, and the price in the currency that method actually charges:
 * shillings for M-Pesa and dollars for the rest, so nobody has to work out
 * which of two currencies applies to them.
 *
 * M-Pesa leads, because most of the people paying pay with it.
 */
const ORDER: PaymentMethod[] = ["mpesa", "apple_pay", "card"];

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
  /** Already formatted, e.g. "$49". */
  priceUsd: string;
  priceMpesaKes: number;
  methods: string[];
  busy: PaymentMethod | null;
  onPick: (method: PaymentMethod) => void;
  onClose: () => void;
}) {
  useScrollLock(true);

  const available = ORDER.filter((m) => methods.includes(m));

  const rows: Record<
    PaymentMethod,
    { mark: React.ReactNode; name: string; hint: string; price: string }
  > = {
    mpesa: {
      mark: <MpesaMark size={12} />,
      name: "M-Pesa",
      hint: "Pay in Kenyan shillings",
      price: `Ksh ${priceMpesaKes.toLocaleString("en-US")}`,
    },
    apple_pay: {
      mark: <ApplePayMark size={12} boxed />,
      name: "Apple Pay",
      // The instruction has to match what pressing it does, and that depends on
      // the device: an iPhone raises the sheet, a Windows desktop cannot.
      hint: applePayIsNative()
        ? "Confirm with Face ID or Touch ID"
        : "Scan a QR code with your iPhone",
      price: priceUsd,
    },
    card: {
      mark: <CardsMark size={22} />,
      name: "Card",
      hint: "Visa or Mastercard, renews monthly",
      price: priceUsd,
    },
  };

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
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold leading-snug">How do you want to pay?</h2>
            <p className="mt-0.5 text-[13px] text-ink-3">{planName}, billed monthly</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-1 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-2.5">
          {available.map((method) => {
            const { mark, name, hint, price } = rows[method];
            return (
              <button
                key={method}
                type="button"
                disabled={!!busy}
                onClick={() => onPick(method)}
                className={cx(
                  "flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                  busy === method
                    ? "border-accent bg-accent-soft"
                    : "border-line hover:border-line-hover hover:bg-surface-3",
                  busy && busy !== method ? "opacity-50" : "",
                )}
              >
                {/* Fixed width, so three marks of different shapes still line
                    the names up with one another. */}
                <span className="flex h-9 w-12 shrink-0 items-center justify-center">{mark}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold leading-tight">{name}</span>
                  <span className="mt-0.5 block text-[12px] leading-tight text-ink-3">{hint}</span>
                </span>
                <span className="shrink-0 font-mono text-[14px] font-semibold">
                  {busy === method ? "…" : price}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-3">
          Secure checkout by Paystack. We never see or store your card details.
        </p>
      </div>
    </div>
  );
}
