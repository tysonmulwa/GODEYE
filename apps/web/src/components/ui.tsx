"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { forwardRef, useState } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export { cx };

// ---------- Button ----------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:opacity-50",
  secondary:
    "bg-surface-2 text-ink border border-line hover:border-line-hover disabled:opacity-50",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-3",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:opacity-50",
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    loading?: boolean;
  }
>(function Button({ variant = "primary", loading, className, children, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex h-9 items-center justify-center gap-2 rounded-[9px] px-3.5 text-[14px] font-semibold",
        "transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent",
        buttonStyles[variant],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
});

// ---------- Inputs ----------

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[14px] text-ink",
          "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15",
          className,
        )}
        {...props}
      />
    );
  },
);

/**
 * Password / secret input with a show-hide eye toggle. Use for any field that
 * hides its value (passwords, API keys, bot tokens) so people can verify what
 * they typed. Omit `type` — it's always a masked field until revealed.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(function PasswordInput({ className, ...props }, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cx(
          "w-full rounded-lg border border-line bg-surface-2 py-2 pl-3 pr-10 text-[14px] text-ink",
          "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15",
          className,
        )}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide" : "Show"}
        title={visible ? "Hide" : "Show"}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-3 transition-colors hover:text-ink"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[14px] leading-relaxed text-ink",
        "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15",
        className,
      )}
      {...props}
    />
  );
});

/** Form/field label — the design sets every label in uppercase mono. */
export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block font-mono text-[12px] font-semibold uppercase tracking-[0.09em] text-ink-3"
    >
      {children}
    </label>
  );
}

/** Eyebrow/section label (mono, uppercase) for card sections. */
export function MonoLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cx(
        "font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-ink-3",
        className,
      )}
    >
      {children}
    </p>
  );
}

// ---------- Card ----------

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-[11px] border border-line bg-surface-2 p-4 transition-colors duration-150 hover:border-line-hover",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------- Badge (status/role chips — mono, per the design every code is mono) ----------

const badgeStyles: Record<string, string> = {
  PENDING: "bg-amber-500/13 text-amber-600",
  PROCESSING: "bg-blue-500/14 text-blue-600",
  PUBLISHED: "bg-emerald-500/13 text-emerald-600",
  FAILED: "bg-red-500/13 text-red-600",
  CANCELLED: "bg-zinc-500/13 text-zinc-500",
  DRAFT: "bg-zinc-500/13 text-zinc-500",
  PENDING_APPROVAL: "bg-amber-500/13 text-amber-600",
  APPROVED: "bg-teal-500/13 text-teal-600",
  SCHEDULED: "bg-violet-500/14 text-violet-600",
  ACTIVE: "bg-emerald-500/13 text-emerald-600",
  ERROR: "bg-red-500/13 text-red-600",
  EXPIRED: "bg-amber-500/13 text-amber-600",
  DISCONNECTED: "bg-zinc-500/13 text-zinc-500",
  OWNER: "bg-accent-soft text-accent-hover",
  ADMIN: "bg-blue-500/14 text-blue-600",
  EDITOR: "bg-emerald-500/13 text-emerald-600",
  VIEWER: "bg-zinc-500/13 text-zinc-500",
  DONE: "bg-emerald-500/13 text-emerald-600",
  SUCCEEDED: "bg-emerald-500/13 text-emerald-600",
  QUEUED: "bg-amber-500/13 text-amber-600",
  RUNNING: "bg-blue-500/14 text-blue-600",
  PAUSED: "bg-zinc-500/13 text-zinc-500",
};

export function Badge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[12px] font-semibold tracking-[0.04em]",
        badgeStyles[status] ?? "bg-zinc-500/13 text-zinc-500",
        className,
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

/** Mono tag chip (plan ids, hashtags, keywords). */
export function MonoChip({
  children,
  tone = "accent",
  className,
}: {
  children: React.ReactNode;
  tone?: "accent" | "faint";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[14px]",
        tone === "accent"
          ? "bg-accent-soft text-accent-hover"
          : "border border-line bg-surface-3 text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------- Live status dot ----------

export function LiveDot({
  color = "#10b981",
  pulse = true,
  className,
}: {
  color?: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", pulse && "animate-pulse-dot", className)}
      style={{ backgroundColor: color }}
    />
  );
}

// ---------- Platform glyph chips (square, brand colour, brand mark) ----------

/**
 * Each platform's mark, drawn white-on-brand-colour in a 24x24 box. Marks are
 * geometric renditions rather than the exact trademarked artwork — enough to be
 * unmistakable at 16-36px, with no asset files to load. A platform with no mark
 * falls back to its initials.
 */
const PLATFORM_MARKS: Record<string, React.ReactNode> = {
  // Rounded square + lens + flash — the Instagram glyph is already primitives.
  INSTAGRAM: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.4" cy="6.6" r="1.3" fill="currentColor" />
    </>
  ),
  // Two crossed strokes, the X wordmark reduced to its form.
  X: (
    <>
      <path d="M4 4 L20 20 M20 4 L4 20" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  // The lowercase f: stem with a crossbar and a shoulder.
  FACEBOOK: (
    <path
      d="M15.6 4.2h-2.3c-2.3 0-3.8 1.5-3.8 3.9v2.2H7.2v3.1h2.3V21h3.3v-7.6h2.4l.5-3.1h-2.9V8.5c0-.8.4-1.2 1.2-1.2h1.6z"
      fill="currentColor"
    />
  ),
  // "in" — dot-stem plus the n.
  LINKEDIN: (
    <>
      <circle cx="6.2" cy="5.6" r="1.9" fill="currentColor" />
      <rect x="4.5" y="9.2" width="3.4" height="10.3" fill="currentColor" />
      <path
        d="M11 9.2h3.2v1.5c.6-1 1.7-1.8 3.3-1.8 2.4 0 3.9 1.5 3.9 4.4v6.2h-3.4v-5.6c0-1.4-.6-2.2-1.8-2.2s-1.9.8-1.9 2.2v5.6H11z"
        fill="currentColor"
      />
    </>
  ),
  // Paper plane.
  TELEGRAM: (
    <path
      d="M21 4.5 2.9 11.4c-.8.3-.8 1.1 0 1.4l4.5 1.4 1.7 5.1c.2.6.6.7 1.1.3l2.5-2.1 4.6 3.4c.7.5 1.2.2 1.4-.6L21.9 5.6c.2-.9-.3-1.4-.9-1.1M8.6 13.6l9.1-5.6-7.5 6.7z"
      fill="currentColor"
    />
  ),
  // Rounded rect with a play triangle.
  YOUTUBE: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" fill="currentColor" />
      <path d="M10.2 9.3v5.4l4.8-2.7z" fill="#FF0000" />
    </>
  ),
  // Round face with antenna and eyes.
  REDDIT: (
    <>
      <circle cx="12" cy="14" r="7.4" fill="currentColor" />
      <circle cx="9.6" cy="13.4" r="1.35" fill="#FF4500" />
      <circle cx="14.4" cy="13.4" r="1.35" fill="#FF4500" />
      <path d="M9.4 16.9c1.5 1.1 3.7 1.1 5.2 0" stroke="#FF4500" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M12 6.6 13 3l3.2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="16.8" cy="3.9" r="1.5" fill="currentColor" />
    </>
  ),
  // Rounded face with two eyes and flared skirt.
  DISCORD: (
    <>
      <path
        d="M18.9 6.6A15 15 0 0 0 15.3 5.5l-.3.6a12 12 0 0 0-6 0l-.3-.6a15 15 0 0 0-3.6 1.1C2.4 10.5 1.7 14.3 2 18a15 15 0 0 0 4.6 2.3l.9-1.4a9.5 9.5 0 0 1-1.5-.8l.4-.3a10.8 10.8 0 0 0 9.2 0l.4.3a9.5 9.5 0 0 1-1.5.8l.9 1.4A15 15 0 0 0 22 18c.4-4.3-.7-8-3.1-11.4"
        fill="currentColor"
      />
      <circle cx="9.1" cy="13.6" r="1.6" fill="#5865F2" />
      <circle cx="14.9" cy="13.6" r="1.6" fill="#5865F2" />
    </>
  ),
  // Stylised @ — the Threads mark.
  THREADS: (
    <>
      <path
        d="M12 21c-5 0-8-3.4-8-9s3.1-9 8-9c3.6 0 6 1.6 7.1 4.2l-2.6.9C15.8 6.4 14.3 5.5 12 5.5c-3.4 0-5.4 2.4-5.4 6.5S8.6 18.5 12 18.5c2.6 0 4.2-1.1 4.2-2.7 0-1.4-1.1-2.3-3.2-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <ellipse cx="12.4" cy="13" rx="3.6" ry="2.8" fill="none" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  // Musical note.
  TIKTOK: (
    <path
      d="M15.3 3h2.9c.2 1.9 1.4 3.4 3.3 3.7v2.9a6.8 6.8 0 0 1-3.4-1v5.8a5.9 5.9 0 1 1-5.9-5.9c.3 0 .6 0 .9.1v3a2.9 2.9 0 1 0 2.2 2.8z"
      fill="currentColor"
    />
  ),
  // Script P.
  PINTEREST: (
    <path
      d="M12 3a9 9 0 0 0-3.3 17.4c-.1-.7-.1-1.8.1-2.6l1.1-4.6s-.3-.6-.3-1.4c0-1.3.8-2.3 1.7-2.3.8 0 1.2.6 1.2 1.4 0 .8-.5 2.1-.8 3.3-.2 1 .5 1.8 1.5 1.8 1.8 0 3.1-1.9 3.1-4.6 0-2.4-1.7-4.1-4.2-4.1a4.3 4.3 0 0 0-4.5 4.3c0 .9.3 1.8.8 2.3l-.3 1.3c0 .2-.2.3-.4.2-1.2-.6-1.9-2.3-1.9-3.8 0-3.1 2.2-5.9 6.4-5.9 3.4 0 6 2.4 6 5.6 0 3.4-2.1 6.1-5 6.1-1 0-1.9-.5-2.2-1.1l-.6 2.3c-.2.9-.8 1.9-1.2 2.6A9 9 0 1 0 12 3"
      fill="currentColor"
    />
  ),
};

const PLATFORM_GLYPHS: Record<string, { glyph: string; bg: string }> = {
  INSTAGRAM: { glyph: "IG", bg: "#E1306C" },
  TIKTOK: { glyph: "TT", bg: "#0f0f0f" },
  X: { glyph: "X", bg: "#18181b" },
  LINKEDIN: { glyph: "in", bg: "#0A66C2" },
  FACEBOOK: { glyph: "f", bg: "#1877F2" },
  PINTEREST: { glyph: "P", bg: "#E60023" },
  YOUTUBE: { glyph: "YT", bg: "#FF0000" },
  TELEGRAM: { glyph: "TG", bg: "#229ED9" },
  DISCORD: { glyph: "DC", bg: "#5865F2" },
  REDDIT: { glyph: "r/", bg: "#FF4500" },
  THREADS: { glyph: "@", bg: "#101319" },
};

export function platformColor(platform: string): string {
  return PLATFORM_GLYPHS[platform]?.bg ?? "#565d6b";
}

export function PlatformGlyph({
  platform,
  size = 24,
  className,
}: {
  platform: string;
  size?: number;
  className?: string;
}) {
  const p = PLATFORM_GLYPHS[platform] ?? { glyph: platform.slice(0, 2), bg: "#565d6b" };
  const mark = PLATFORM_MARKS[platform];
  return (
    <span
      aria-label={platform}
      title={platform.charAt(0) + platform.slice(1).toLowerCase()}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-[6px] font-mono font-semibold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: p.bg,
        fontSize: Math.max(10, Math.round(size * 0.4)),
      }}
    >
      {mark ? (
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          style={{ width: Math.round(size * 0.64), height: Math.round(size * 0.64) }}
        >
          {mark}
        </svg>
      ) : (
        p.glyph
      )}
    </span>
  );
}

// ---------- Segmented control ----------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("inline-flex rounded-lg bg-surface-3 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-2.5 py-1 font-mono text-[14px] font-medium transition-colors",
            o.value === value
              ? "bg-surface-2 text-ink shadow-sm"
              : "text-ink-3 hover:text-ink-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Sparkline (indigo polyline + faint area fill) ----------

export function Sparkline({
  points,
  width = 60,
  height = 34,
  className,
}: {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map(
    (p, i) => [i * step, height - 3 - ((p - min) / range) * (height - 6)] as const,
  );
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <polygon points={area} fill="var(--accent)" opacity={0.09} />
      <polyline
        points={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------- Feedback ----------

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[14px] text-red-600">
      {message}
    </p>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[11px] border border-dashed border-line py-14 text-center">
      <p className="text-[14px] font-medium text-ink-2">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

// ---------- Switch (36×20 pill, 14px knob) ----------

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-[14px] font-medium text-ink">{label}</span>}
          {hint && <span className="mt-0.5 block text-xs leading-snug text-ink-3">{hint}</span>}
        </span>
      )}
      {/* Flex-positioned knob: vertically centered, slides between exact 3px insets */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          "inline-flex h-5 w-9 shrink-0 items-center rounded-full px-[3px] transition-colors duration-150",
          checked ? "justify-end bg-accent" : "justify-start bg-line-hover",
        )}
      >
        <span className="h-3.5 w-3.5 rounded-full bg-white shadow-sm" />
      </button>
    </label>
  );
}

// ---------- Page header ----------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  /** Rendered as a mono status sub-line (design: `live · synced 2s ago · 6 channels`). */
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[19px] font-bold tracking-[-0.02em]">{title}</h1>
        {subtitle && (
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[14px] text-ink-3">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
