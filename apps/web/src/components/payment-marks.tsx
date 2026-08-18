"use client";

import { cx } from "@/components/ui";

/**
 * The marks of the things people pay with, drawn rather than approximated.
 *
 * A payment screen is the one place a customer is deciding whether to trust
 * the page. A wrong logo, or a generic icon standing in for a brand they know,
 * reads as a counterfeit exactly there. Apple is explicit about this in its
 * guidelines, and M-Pesa is the most recognised brand in the market this
 * product sells into.
 *
 * Inline SVG rather than hosted images: they take the colour of the text
 * around them where that is right, keep their brand colours where that is
 * right, stay sharp at any size, and cannot fail to load.
 */

/** The Apple logo alone, in the current text colour. */
export function AppleLogo({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/**
 * Apple Pay: the logo followed by the word, set as one unit.
 *
 * `boxed` draws Apple's rounded outline around it, the form used where the mark
 * stands alone as a payment option rather than sitting inside a sentence.
 */
export function ApplePayMark({
  className,
  boxed = false,
  size = 13,
}: {
  className?: string;
  boxed?: boolean;
  size?: number;
}) {
  const lockup = (
    <span
      className="inline-flex items-center gap-[0.14em] whitespace-nowrap font-semibold"
      style={{ fontSize: size }}
    >
      <AppleLogo size={size * 1.02} />
      <span style={{ letterSpacing: "-0.01em" }}>Pay</span>
    </span>
  );

  if (!boxed) return <span className={cx("inline-flex", className)}>{lockup}</span>;

  return (
    <span
      className={cx(
        "inline-flex items-center justify-center rounded-[0.42em] border-[0.09em] border-current",
        className,
      )}
      style={{ padding: `${size * 0.3}px ${size * 0.6}px` }}
    >
      {lockup}
    </span>
  );
}

/** Safaricom's green, and the red of the swoosh on the handset. */
const MPESA_GREEN = "#43B02A";
const MPESA_RED = "#E4002B";

/**
 * The M-Pesa handset: the glyph that sits inside the wordmark.
 *
 * Kept as the icon on its own, because at the size a list row gives it the
 * full wordmark would be unreadable, and a green phone with a red swoosh is
 * the part people recognise.
 */
export function MpesaGlyph({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 20 30"
      width={(size * 20) / 30}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect x="0.75" y="0.75" width="18.5" height="28.5" rx="4" fill="#EDF5EC" stroke={MPESA_GREEN} strokeWidth="1.5" />
      <path d="M2.6 15.8c3.4-3.6 6.2-4.2 8.3-3.2 1 .5 1.7 1.4 2.6 1.6.9.2 2-.2 3.6-1.7-1 3.4-2.6 4.9-4.2 5-1.5.1-2.7-.9-4-1.3-1.4-.4-3.1-.1-6.3 1.6z" fill={MPESA_RED} />
    </svg>
  );
}

/** M-PESA, as the wordmark reads: the name in Safaricom green. */
export function MpesaMark({ className, size = 13 }: { className?: string; size?: number }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1 whitespace-nowrap font-bold", className)}
      style={{ fontSize: size, color: MPESA_GREEN, letterSpacing: "0.01em" }}
    >
      <MpesaGlyph size={size * 1.35} />
      <span>M-PESA</span>
    </span>
  );
}

/**
 * Two cards, one behind the other, in the current text colour.
 *
 * The stacked pair rather than a single rectangle, because one rectangle at
 * this size reads as a generic box while two read as cards.
 */
export function CardsMark({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {/* The card behind, tilted, with its magnetic stripe. */}
      <path d="M14.53 1.6 6.9 9.23a2 2 0 0 0 0 2.83l1.06 1.06 9.9-9.9-1.06-1.06a2 2 0 0 0-2.27-.56zm4.04 2.68-9.9 9.9 3.18 3.18a2 2 0 0 0 2.83 0l7.07-7.07a2 2 0 0 0 0-2.83l-3.18-3.18zm-.7 3.9 1.76 1.77-1.42 1.41-1.76-1.76 1.41-1.42z" opacity="0.45" />
      {/* The card in front, square on, with its chip. */}
      <rect x="2" y="11.5" width="15" height="10.5" rx="2" />
      <rect x="4" y="13.6" width="3.4" height="2.4" rx="0.7" fill="#fff" opacity="0.85" />
    </svg>
  );
}
