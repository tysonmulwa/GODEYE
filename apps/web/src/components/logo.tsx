/**
 * GODEYE brand marks — the all-seeing eye set in a triangle.
 *
 * `GodeyeMark`    raw stroke glyph in currentColor. Tuned to stay legible at
 *                 ~20px, so it carries only the triangle, eye and pupil.
 * `GodeyeEmblem`  the full crest: double triangle, radiating rays and an outer
 *                 ring. Detail only survives above ~64px — use it for hero
 *                 placements (auth pages, marketing), never in dense chrome.
 * `GodeyeBadge`   the mark on a gradient tile, for app chrome.
 * `GodeyeLockup`  badge + wordmark.
 */

/** Almond (vesica) eye used by both marks, drawn around cy. */
const EYE_PATH = "M27 57 Q50 39 73 57 Q50 75 27 57 Z";

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
        d="M50 13 L88 82 L12 82 Z"
        stroke="currentColor"
        strokeWidth="8.5"
        strokeLinejoin="round"
      />
      <path d={EYE_PATH} stroke="currentColor" strokeWidth="6" strokeLinejoin="round" />
      <circle cx="50" cy="57" r="7.5" fill="currentColor" />
    </svg>
  );
}

export function GodeyeEmblem({
  className,
  style,
  rays = 40,
}: {
  className?: string;
  style?: React.CSSProperties;
  /** Number of radiating rays; fewer reads better at smaller sizes. */
  rays?: number;
}) {
  // Rays sit between the outer ring and the crest so the triangle stays readable.
  const spokes = Array.from({ length: rays }, (_, i) => {
    const angle = (i / rays) * Math.PI * 2 - Math.PI / 2;
    const [inner, outer] = i % 2 === 0 ? [80, 94] : [84, 94];
    return {
      x1: 100 + Math.cos(angle) * inner,
      y1: 100 + Math.sin(angle) * inner,
      x2: 100 + Math.cos(angle) * outer,
      y2: 100 + Math.sin(angle) * outer,
      key: i,
    };
  });

  return (
    <svg viewBox="0 0 200 200" fill="none" className={className} style={style} aria-hidden>
      <g stroke="currentColor" strokeLinejoin="round" strokeLinecap="round">
        {spokes.map((s) => (
          <line key={s.key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} strokeWidth="1.6" />
        ))}
        <circle cx="100" cy="100" r="76" strokeWidth="1.8" opacity="0.65" />

        {/* Double triangle — the outer keeps weight, the inner adds the etched line */}
        <path d="M100 30 L166 148 L34 148 Z" strokeWidth="3.4" />
        <path d="M100 48 L150 140 L50 140 Z" strokeWidth="1.4" opacity="0.55" />

        {/* Geometric web, echoing the reference crest */}
        <g strokeWidth="1" opacity="0.4">
          <path d="M100 30 L100 140 M34 148 L150 140 M166 148 L50 140" />
          <path d="M50 140 L100 48 L150 140" />
        </g>

        {/* Eye, scaled from the 100-unit mark into this 200-unit canvas */}
        <g transform="translate(100 108) scale(1.35) translate(-50 -57)">
          <path d={EYE_PATH} strokeWidth="4.4" />
          <circle cx="50" cy="57" r="9" strokeWidth="3.4" />
          <circle cx="50" cy="57" r="3.6" fill="currentColor" stroke="none" />
        </g>
      </g>
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

/** Horizontal lockup: gradient badge + wordmark. */
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

/** Stacked crest + wordmark for hero placements (auth pages). */
export function GodeyeCrest({
  size = 112,
  wordClass = "text-[17px]",
}: {
  size?: number;
  wordClass?: string;
}) {
  return (
    <span className="inline-flex flex-col items-center gap-3 text-ink">
      <GodeyeEmblem style={{ width: size, height: size }} />
      <span className={`font-display tracking-[0.22em] ${wordClass}`}>GODEYE</span>
    </span>
  );
}
