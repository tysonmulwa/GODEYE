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
        "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[9px] px-3.5 text-[14px] font-semibold",
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
 * they typed. Omit `type`, it's always a masked field until revealed.
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

/** Form/field label, the design sets every label in uppercase mono. */
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
        // A wider radius than a printed panel would take: glass reads as a
        // physical pane, and a tight corner makes it look like a rectangle
        // drawn on the page instead of one resting above it. The hover lift
        // is a plain CSS rule, a Tailwind arbitrary value cannot hold the
        // commas a two-part box-shadow needs.
        "glass glass-hover rounded-2xl p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------- Badge (status/role chips, mono, per the design every code is mono) ----------

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
  // SEO fix lifecycle
  PROPOSED: "bg-zinc-500/13 text-zinc-500",
  APPLIED: "bg-blue-500/14 text-blue-600",
  VERIFIED: "bg-emerald-500/13 text-emerald-600",
  DISMISSED: "bg-zinc-500/13 text-zinc-500",
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
 * Brand marks moved to platform-marks.tsx: this file is "use client", and a
 * JSX value exported from a client module reaches a Server Component as a
 * client reference rather than the element itself. Re-exported here so every
 * existing import keeps working.
 */
import { PLATFORM_GLYPHS, PLATFORM_MARKS } from "./platform-marks";

export { PLATFORM_MARKS, PLATFORM_GLYPHS };

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
      /*
       * `role="img"` is not decoration. `aria-label` is PROHIBITED on a
       * generic span — an element with no role — so a screen reader ignored it
       * outright and announced these marks as nothing at all. That affected
       * the connections list, the composer and the calendar, not just the
       * marketing pages; it surfaced when the landing page's axe gate started
       * covering the product previews. WCAG 4.1.2 Name, Role, Value.
       */
      role="img"
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
