"use client";

import { Loader2 } from "lucide-react";
import { forwardRef } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export { cx };

// ---------- Button ----------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:bg-accent-hover shadow-sm disabled:opacity-50",
  secondary:
    "bg-surface-3 text-ink border border-line hover:border-ink-3 disabled:opacity-50",
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
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium",
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
          "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink",
          "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink",
        "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20",
        className,
      )}
      {...props}
    />
  );
});

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-ink-2">
      {children}
    </label>
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
    <div className={cx("rounded-xl border border-line bg-surface-2 p-5", className)}>
      {children}
    </div>
  );
}

// ---------- Badge ----------

const badgeStyles: Record<string, string> = {
  PENDING: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  PROCESSING: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PUBLISHED: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  FAILED: "bg-red-500/15 text-red-600 dark:text-red-400",
  CANCELLED: "bg-zinc-500/15 text-zinc-500",
  DRAFT: "bg-zinc-500/15 text-zinc-500",
  PENDING_APPROVAL: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  APPROVED: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  SCHEDULED: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  OWNER: "bg-accent/15 text-accent",
  ADMIN: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  EDITOR: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  VIEWER: "bg-zinc-500/15 text-zinc-500",
  ACTIVE: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  ERROR: "bg-red-500/15 text-red-600 dark:text-red-400",
  EXPIRED: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  DISCONNECTED: "bg-zinc-500/15 text-zinc-500",
};

export function Badge({ status }: { status: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide",
        badgeStyles[status] ?? "bg-zinc-500/15 text-zinc-500",
      )}
    >
      {status}
    </span>
  );
}

// ---------- Feedback ----------

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line py-14 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

// ---------- Switch ----------

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
    <label className="flex cursor-pointer items-start justify-between gap-3">
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium text-ink">{label}</span>}
          {hint && <span className="mt-0.5 block text-xs text-ink-3">{hint}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-surface-3 border border-line",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
