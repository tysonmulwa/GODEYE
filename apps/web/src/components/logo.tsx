/**
 * GODEYE brand marks, the all-seeing eye set in a triangle.
 *
 * `GodeyeMark`    raw stroke glyph in currentColor. Tuned to stay legible at
 *                 ~20px, so it carries only the triangle, eye and pupil.
 * `GodeyeEmblem`  the full crest: double triangle, radiating rays and an outer
 *                 ring. Detail only survives above ~64px, use it for hero
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
  variant = "full",
  rays,
}: {
  className?: string;
  style?: React.CSSProperties;
  /**
   * "full" for hero sizes; "compact" thins the detail (fewer rays, no web,
   * heavier strokes) so the crest still reads in chrome around 24–32px, where
   * fine lines would otherwise collapse into a smudge.
   */
  variant?: "full" | "compact";
  /** Override the ray count. */
  rays?: number;
}) {
  const compact = variant === "compact";
  const rayCount = rays ?? (compact ? 16 : 40);

  // Rays sit between the outer ring and the crest so the triangle stays readable.
  const spokes = Array.from({ length: rayCount }, (_, i) => {
    const angle = (i / rayCount) * Math.PI * 2 - Math.PI / 2;
    const inner = compact ? 82 : i % 2 === 0 ? 80 : 84;
    return {
      x1: 100 + Math.cos(angle) * inner,
      y1: 100 + Math.sin(angle) * inner,
      x2: 100 + Math.cos(angle) * 94,
      y2: 100 + Math.sin(angle) * 94,
      key: i,
    };
  });

  return (
    <svg viewBox="0 0 200 200" fill="none" className={className} style={style} aria-hidden>
      <g stroke="currentColor" strokeLinejoin="round" strokeLinecap="round">
        {spokes.map((s) => (
          <line
            key={s.key}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            strokeWidth={compact ? 4 : 1.6}
          />
        ))}
        <circle
          cx="100"
          cy="100"
          r="76"
          strokeWidth={compact ? 3.5 : 1.8}
          opacity={compact ? 0.9 : 0.65}
        />

        {/* Double triangle, the outer keeps weight, the inner adds the etched line */}
        <path d="M100 30 L166 148 L34 148 Z" strokeWidth={compact ? 6 : 3.4} />
        <path
          d="M100 48 L150 140 L50 140 Z"
          strokeWidth={compact ? 3 : 1.4}
          opacity={compact ? 0.8 : 0.55}
        />

        {/* Circuit web, the geometry that makes this read as tech rather than
            occult. Compact keeps only the trusses that survive ~26px. */}
        {compact ? (
          <g strokeWidth="2.6" opacity="0.7">
            <path d="M100 30 L100 48" />
            <path d="M50 140 L34 148 M150 140 L166 148" />
          </g>
        ) : (
          <g strokeWidth="1" opacity="0.4">
            <path d="M100 30 L100 140 M34 148 L150 140 M166 148 L50 140" />
            <path d="M50 140 L100 48 L150 140" />
            {/* Corner trusses. Nothing between y 84-132 across the centre,
                the eye lives there and lines would cut through it. */}
            <path d="M34 148 L62 126 M166 148 L138 126" />
          </g>
        )}

        {/* Eye, scaled from the 100-unit mark into this 200-unit canvas */}
        <g transform="translate(100 108) scale(1.35) translate(-50 -57)">
          <path d={EYE_PATH} strokeWidth={compact ? 5.5 : 4.4} />
          {compact ? (
            <circle cx="50" cy="57" r="6" fill="currentColor" stroke="none" />
          ) : (
            <>
              <circle cx="50" cy="57" r="9" strokeWidth="3.4" />
              <circle cx="50" cy="57" r="3.6" fill="currentColor" stroke="none" />
            </>
          )}
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
      <GodeyeEmblem
        variant="compact"
        className="relative"
        style={{ width: Math.round(size * 0.86), height: Math.round(size * 0.86) }}
      />
    </span>
  );
}

/**
 * Horizontal lockup: bare crest + wordmark, drawn in currentColor so it matches
 * the auth pages rather than sitting in a coloured tile.
 */
export function GodeyeLockup({
  size = 32,
  wordClass = "text-[13px]",
}: {
  size?: number;
  wordClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <GodeyeEmblem variant="compact" style={{ width: size, height: size }} />
      <span className={`font-display tracking-wider ${wordClass}`}>GODEYE</span>
    </span>
  );
}

/**
 * Slowly rotating crest, for "the agent is working" states. Uses a CSS
 * animation rather than framer-motion so it costs nothing while idle, and
 * respects prefers-reduced-motion via the `motion-safe:` prefix.
 */
export function GodeyeSpinner({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <GodeyeEmblem
      variant="compact"
      className={`motion-safe:animate-[spin_3.2s_linear_infinite] ${className ?? ""}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The whole screen while the app works out who you are.
 *
 * This is the first thing anyone sees on the URL, before any page has decided
 * what to render, so it was a generic grey spinner on white, which belongs to
 * no product in particular. The crest costs the same and says whose app is
 * loading.
 *
 * Deliberately not the accent colour: on a bare screen a large purple mark
 * reads as an alert rather than as a wait, and this appears before anything is
 * wrong. Ink keeps it calm and works in both themes.
 */
export function GodeyeBootScreen() {
  return (
    <div className="flex h-svh items-center justify-center">
      <GodeyeSpinner size={56} className="text-ink-2" />
      <span className="sr-only">Loading GODEYE</span>
    </div>
  );
}

/** Stacked crest + wordmark for hero placements (auth pages). */
export function GodeyeCrest({
  size = 112,
  wordClass = "text-[17px]",
  align = "center",
}: {
  size?: number;
  wordClass?: string;
  /**
   * The emblem is narrower than the wordmark, so centring the two leaves the
   * emblem visibly indented when the crest sits in a left-aligned column,
   * which is how it looked on the homepage. Centre it on centred layouts,
   * start it on left-aligned ones, so the two always share an edge.
   */
  align?: "center" | "start";
}) {
  return (
    <span
      className={`inline-flex flex-col gap-3 text-ink ${
        align === "start" ? "items-start" : "items-center"
      }`}
    >
      <GodeyeEmblem style={{ width: size, height: size }} />
      <span className={`font-display tracking-[0.22em] ${wordClass}`}>GODEYE</span>
    </span>
  );
}
