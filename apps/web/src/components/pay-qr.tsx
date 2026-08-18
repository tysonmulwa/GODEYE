"use client";

import { Check, Loader2, Smartphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { GodeyeCrest } from "@/components/logo";
import { ApplePayMark, Button, cx } from "@/components/ui";
import { useScrollLock } from "@/lib/use-scroll-lock";

/**
 * Pay on your phone, from a computer that cannot.
 *
 * Apple Pay only appears on Apple devices, so somebody on a Windows PC never
 * sees it however well the domain is verified. Apple's own answer to that is a
 * QR the iPhone camera recognises as a payment handoff, but that code is minted
 * by Apple for a validated merchant session and cannot be drawn by us, a QR we
 * generate is a link, and a link is all the camera will treat it as.
 *
 * A link is enough. This encodes the Paystack checkout itself: the customer
 * scans it, the checkout opens on the phone, where Apple Pay does appear, and
 * where M-Pesa is one tap, and this page notices the payment landing and moves
 * on by itself. The difference from Apple's version is where the sheet comes
 * from, not what the customer ends up doing.
 *
 * The mark in the middle is GODEYE's, not Apple's. This code opens a checkout
 * that may well be paid with M-Pesa or a card, and Apple's logo on it would
 * tell the customer something untrue about what they are scanning.
 */

/** Highest error correction, because the logo covers the middle of the code. */
const QR_OPTIONS = { errorCorrectionLevel: "H", margin: 1, width: 640 } as const;

export function PayOnPhone({
  url,
  planName,
  price,
  method,
  paid,
  onClose,
}: {
  url: string;
  planName: string;
  /** Already formatted, in the currency actually charged. */
  price: string;
  method: "apple_pay" | "mpesa";
  /** True once the payment has been seen, the dialog says so and closes. */
  paid: boolean;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useScrollLock(true);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, QR_OPTIONS)
      .then((out) => {
        if (!cancelled) setDataUrl(out);
      })
      .catch(() => {
        // Never leave the customer with a blank square and no way through:
        // the "continue on this device" button below still works.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pay on your phone"
      className="fixed inset-0 z-60 flex items-center justify-center bg-ink/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-surface-2 p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="text-left">
            <h2 className="text-[17px] font-semibold leading-snug">
              {paid ? "Payment received" : "Scan with your phone"}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {planName} · <span className="font-mono">{price}</span>
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

        <div className="my-5 flex justify-center">
          {paid ? (
            <div className="flex h-[232px] w-[232px] items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
              <Check className="h-16 w-16 text-emerald-500" strokeWidth={1.5} />
            </div>
          ) : dataUrl ? (
            <div className="relative">
              {/* White always, never a themed surface: a dark background behind
                  a QR inverts it, and half the camera apps will not read it. */}
              <img
                src={dataUrl}
                alt={`QR code to pay ${price} for ${planName} on your phone`}
                width={232}
                height={232}
                className="rounded-xl border border-line bg-white p-2"
              />
              <span className="pointer-events-none absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg bg-white shadow-sm">
                <GodeyeCrest size={26} />
              </span>
            </div>
          ) : (
            <div
              className={cx(
                "flex h-[232px] w-[232px] items-center justify-center rounded-xl border border-line",
                failed ? "" : "animate-pulse bg-surface-3",
              )}
            >
              {failed && (
                <p className="px-6 text-[13px] text-ink-3">
                  The code could not be drawn. Use the button below instead.
                </p>
              )}
            </div>
          )}
        </div>

        {paid ? (
          <p className="text-[13px] leading-relaxed text-ink-2">
            Your workspace is on {planName}. You can close this.
          </p>
        ) : (
          <>
            <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-[13px] leading-relaxed text-ink-2">
              <Smartphone className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              <span>Open the Camera app and point it at the code. Pay with</span>
              {method === "apple_pay" ? <ApplePayMark /> : <span>M-Pesa</span>}
              <span>on your phone.</span>
            </p>
            <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-ink-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for payment, this page will move on by itself.
            </p>
          </>
        )}

        <div className="mt-5 flex flex-col gap-2">
          {paid ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => (window.location.href = url)}>
                Continue on this device
              </Button>
              <button
                type="button"
                onClick={onClose}
                className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink-2"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
