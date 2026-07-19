/**
 * GODEYE brand mark — triangle "all-seeing eye".
 * `GodeyeMark` is the raw stroke glyph (currentColor, scales anywhere).
 * `GodeyeBadge` is the presentation-grade version: white glyph on an
 * indigo→violet gradient tile with a soft top highlight — use this in chrome.
 */
export function GodeyeMark({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} style={style} aria-hidden>
      <path
        d="M50 16 L85 81 L15 81 Z"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M30 57 Q50 45 70 57 Q50 69 30 57 Z"
        stroke="currentColor"
        strokeWidth="6.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="50" cy="57" r="7" fill="currentColor" />
    </svg>
  );
}

export function GodeyeBadge({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden text-white shadow-sm"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size * 0.28)),
        background: "linear-gradient(135deg, #6366f1 0%, #7c5cf0 55%, #8b5cf6 100%)",
      }}
    >
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 45%)",
        }}
      />
      <GodeyeMark
        className="relative"
        style={{ width: Math.round(size * 0.68), height: Math.round(size * 0.68) }}
      />
    </span>
  );
}

/** Horizontal lockup: gradient badge + Michroma wordmark. */
export function GodeyeLockup({
  size = 30,
  wordClass = "text-[13px]",
}: {
  size?: number;
  wordClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2.5 text-ink">
      <GodeyeBadge size={size} />
      <span className={`font-display tracking-wider ${wordClass}`}>GODEYE</span>
    </span>
  );
}
