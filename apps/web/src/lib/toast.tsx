"use client";

import { CheckCircle2, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { cx } from "@/components/ui";

/**
 * Small notifications for things that finished somewhere the eye is not.
 *
 * Scheduling a post already confirmed itself, at the bottom of a long form,
 * below the fold on a phone. The work happened and the screen looked
 * unchanged, which reads as nothing having happened at all.
 */
type ToastKind = "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (message: string, action?: Toast["action"]) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DISMISS_AFTER_MS = 7000;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, message: string, action?: Toast["action"]) => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), kind, message, action }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const api: ToastApi = {
    success: useCallback((m, a) => push("success", m, a), [push]),
    error: useCallback((m) => push("error", m), [push]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Bottom of the screen on a phone, where a thumb already is, and out of
          the way of the top bar. pointer-events-none so a stack of these never
          blocks the page underneath; each toast re-enables its own. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <ToastRow key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const Icon = toast.kind === "success" ? CheckCircle2 : XCircle;
  return (
    <div
      className={cx(
        "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-[11px] border px-3.5 py-3 shadow-lg",
        "border-line bg-surface-2",
      )}
    >
      <Icon
        className={cx(
          "mt-0.5 h-4 w-4 shrink-0",
          toast.kind === "success" ? "text-emerald-500" : "text-red-500",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] leading-snug text-ink">{toast.message}</p>
        {toast.action && (
          <button
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="mt-1 text-[13px] font-semibold text-accent hover:text-accent-hover"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
