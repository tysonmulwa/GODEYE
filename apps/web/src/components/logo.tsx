/**
 * GODEYE brand mark — triangle "all-seeing eye", stroke-based and single-color
 * (currentColor) so it works from favicon size to hero size and in any theme.
 */
export function GodeyeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden>
      <path
        d="M50 14 L86 82 L14 82 Z"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M28 56 Q50 44 72 56 Q50 68 28 56 Z"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="50" cy="56" r="7.5" fill="currentColor" />
    </svg>
  );
}

/** Horizontal lockup: symbol + Michroma wordmark. */
export function GodeyeLockup({
  markClass = "h-[27px] w-[27px]",
  wordClass = "text-[14px]",
}: {
  markClass?: string;
  wordClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2.5 text-ink">
      <GodeyeMark className={markClass} />
      <span className={`font-display tracking-[0.04em] ${wordClass}`}>GODEYE</span>
    </span>
  );
}
