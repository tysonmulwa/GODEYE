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
 * Each platform's mark, drawn white-on-brand-colour in a 24x24 box. Marks are
 * geometric renditions rather than the exact trademarked artwork, enough to be
 * unmistakable at 16-36px, with no asset files to load. A platform with no mark
 * falls back to its initials.
 */
/**
 * Official brand marks, single-path and monochrome, drawn in currentColor so
 * they render white on the chip's brand colour. Paths come from Simple Icons
 * (CC0), which publishes each platform's own artwork, so these are the real
 * logos, not approximations, and carry no attribution requirement.
 *
 * LinkedIn is the exception: Simple Icons no longer ships it, so its mark is
 * drawn here.
 */
const PLATFORM_MARKS: Record<string, React.ReactNode> = {
  FACEBOOK: <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" fill="currentColor" />,
  INSTAGRAM: <path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" fill="currentColor" />,
  X: <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" fill="currentColor" />,
  TIKTOK: <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" fill="currentColor" />,
  YOUTUBE: <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" fill="currentColor" />,
  LINKEDIN: (
    <><circle cx="4.98" cy="3.5" r="2.5" fill="currentColor" /><rect x="2.5" y="8" width="5" height="13" fill="currentColor" /><path d="M9.5 8h4.8v1.8a5.2 5.2 0 0 1 4.7-2.6c3.4 0 5.5 2.2 5.5 6.3V21h-5v-6.1c0-1.9-.8-3.1-2.5-3.1s-2.6 1.2-2.6 3.1V21h-5z" fill="currentColor" /></>
  ),
  REDDIT: <path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" fill="currentColor" />,
  DISCORD: <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" fill="currentColor" />,
  TELEGRAM: <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" fill="currentColor" />,
  THREADS: <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z" fill="currentColor" />,
  PINTEREST: <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" fill="currentColor" />,
};

const PLATFORM_GLYPHS: Record<string, { glyph: string; bg: string }> = {
  FACEBOOK: { glyph: "f", bg: "#0866FF" },
  INSTAGRAM: { glyph: "IG", bg: "#E1306C" },
  X: { glyph: "X", bg: "#18181b" },
  TIKTOK: { glyph: "TT", bg: "#0f0f0f" },
  YOUTUBE: { glyph: "YT", bg: "#FF0000" },
  LINKEDIN: { glyph: "in", bg: "#0A66C2" },
  REDDIT: { glyph: "r/", bg: "#FF4500" },
  DISCORD: { glyph: "DC", bg: "#5865F2" },
  TELEGRAM: { glyph: "TG", bg: "#26A5E4" },
  THREADS: { glyph: "@", bg: "#101319" },
  PINTEREST: { glyph: "P", bg: "#BD081C" },
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
