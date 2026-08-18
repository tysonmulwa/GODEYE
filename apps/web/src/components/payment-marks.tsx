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

/** Safaricom's green, and the red of the swoosh across the handset. */
const MPESA_GREEN = "#3CB44A";
const MPESA_RED = "#E1251B";

/**
 * The handset from the M-PESA wordmark.
 *
 * It is not an icon sitting beside the name: in the wordmark it stands where
 * the hyphen would be, between the M and the P, and it is taller than the
 * letters so it overhangs them at both ends. A pale sage body with a white
 * screen, and a red wave crossing it that runs past the body on both sides.
 */
export function MpesaPhone({ className, size = 24 }: { className?: string; size?: number }) {
  // overflow visible: the wave runs past the handset on both sides and tucks
  // under the letters, so it has to be allowed outside its own box.
  return (
    <svg
      viewBox="0 0 19 46"
      width={(size * 19) / 46}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ overflow: "visible" }}
    >
      <rect x="0" y="0" width="19" height="46" rx="5" fill="#D9E7DA" />
      <rect x="2.5" y="3.5" width="14" height="19" rx="2.5" fill="#FFFFFF" />
      <path
        d="M-7 27C2 26.5 8 22.5 13 17.5C17 13.5 21 11.5 26 13C21 19 16 25.5 10 29C4 32 -2 31.5 -7 30Z"
        fill={MPESA_RED}
      />
    </svg>
  );
}

/**
 * M-PESA, set the way the wordmark is set.
 *
 * The letters take the page's own bold weight rather than pretending to be
 * Safaricom's typeface, but the shape of the mark is right: M, handset, PESA,
 * with no hyphen, because the handset is the hyphen.
 */
export function MpesaMark({ className, size = 15 }: { className?: string; size?: number }) {
  return (
    <span
      className={cx("inline-flex items-center whitespace-nowrap font-extrabold", className)}
      style={{ fontSize: size, color: MPESA_GREEN, letterSpacing: "-0.01em", lineHeight: 1 }}
    >
      <span>M</span>
      {/* Overlapped a little at each side, the way the wave tucks under the
          letters in the wordmark. */}
      <MpesaPhone size={size * 1.5} className="mx-[0.14em]" />
      <span>PESA</span>
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
      {/* The card behind, tilted, with its magnetic stripe. Held back a
          little so the two read as two rather than as one odd shape. */}
      <path
        d="M14.53 1.6 6.9 9.23a2 2 0 0 0 0 2.83l1.06 1.06 9.9-9.9-1.06-1.06a2 2 0 0 0-2.27-.56zm4.04 2.68-9.9 9.9 3.18 3.18a2 2 0 0 0 2.83 0l7.07-7.07a2 2 0 0 0 0-2.83l-3.18-3.18z"
        opacity="0.55"
      />
      {/* The card in front, square on. The chip is cut out of the shape rather
          than painted over it, so it works on a light sidebar and a dark one. */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 11.5h11a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2zm0.7 2.1a.7.7 0 0 0-.7.7v1a.7.7 0 0 0 .7.7h2a.7.7 0 0 0 .7-.7v-1a.7.7 0 0 0-.7-.7h-2z"
      />
    </svg>
  );
}
