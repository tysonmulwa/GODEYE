"use client";

import { Clock, Lock, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TRIAL_HOURS } from "@godeye/shared";
import { Button, cx } from "@/components/ui";
import { useAuthStore } from "@/lib/auth-store";
import { useScrollLock } from "@/lib/use-scroll-lock";

/**
 * What a new workspace is told, and what an expired one is told.
 *
 * The welcome is shown once per workspace per browser: somebody who signs in
 * every morning does not need to be congratulated on signing up. The lock
 * notice is shown once per browser session instead, because it is the answer to
 * "why did that button just fail" and reloading the page is exactly what people
 * do when they are trying to find out.
 *
 * Neither of these enforces anything. The API refuses the write itself; this is
 * the part that explains it in advance rather than as a red error at the end of
 * writing a post.
 */

const seenTrialKey = (orgId: string) => `godeye:trial-welcome:${orgId}`;
const seenLockKey = (orgId: string) => `godeye:trial-lock:${orgId}`;

/** "23 hours", "45 minutes" or "under a minute". Never "23.4h". */
function remaining(endsAt: string): string {
  const ms = Date.parse(endsAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "no time";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function endsAtLabel(endsAt: string): string {
  return new Date(endsAt).toLocaleString(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Dialog({
  icon,
  title,
  children,
  actions,
  onClose,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  onClose: () => void;
}) {
  useScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-60 flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-line bg-surface-2 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </span>
          <h2 className="flex-1 text-[17px] font-semibold leading-snug">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 space-y-3 text-[14px] leading-relaxed text-ink-2">{children}</div>
        <div className="mt-6 flex flex-wrap gap-2.5">{actions}</div>
      </div>
    </div>
  );
}

export function TrialNotice() {
  const router = useRouter();
  const organization = useAuthStore((s) => s.organization);
  const access = organization?.access;
  const orgId = organization?.id;

  const [dialog, setDialog] = useState<"welcome" | "locked" | null>(null);
  // Re-rendered on a timer so "23 hours left" becomes "22 hours left" without a
  // reload. A minute is far finer than the number on screen ever changes.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Storage is read in an effect, never during render: the server has no
  // localStorage, and reading it while rendering makes the first paint disagree
  // with the second.
  useEffect(() => {
    if (!orgId || !access) return;
    try {
      if (access.status === "TRIALING" && !localStorage.getItem(seenTrialKey(orgId))) {
        setDialog("welcome");
      } else if (access.locked && !sessionStorage.getItem(seenLockKey(orgId))) {
        setDialog("locked");
      }
    } catch {
      // Private browsing can refuse storage entirely. A workspace that cannot
      // remember the notice is not a reason to fail; it just sees it again.
    }
  }, [orgId, access]);

  if (!organization || !access) return null;

  const close = () => {
    try {
      if (dialog === "welcome" && orgId) localStorage.setItem(seenTrialKey(orgId), "1");
      if (dialog === "locked" && orgId) sessionStorage.setItem(seenLockKey(orgId), "1");
    } catch {
      /* see above */
    }
    setDialog(null);
  };

  const closeAndOpenBilling = () => {
    close();
    router.push("/billing");
  };

  const trialing = access.status === "TRIALING" && !!access.trialEndsAt;

  return (
    <>
      {(trialing || access.locked) && (
        <div
          className={cx(
            "flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-[13px] sm:px-6 lg:px-7",
            access.locked
              ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
              : "border-line-soft bg-accent-soft text-ink-2",
          )}
        >
          {access.locked ? (
            <Lock className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Clock className="h-3.5 w-3.5 shrink-0 text-accent" />
          )}
          <span>
            {access.locked ? (
              <>Your free trial has ended. This workspace is read-only until you choose a plan.</>
            ) : (
              <>
                Free trial,{" "}
                <span className="font-mono font-semibold">
                  {remaining(access.trialEndsAt as string)}
                </span>{" "}
                of full access left.
              </>
            )}
          </span>
          <Link
            href="/billing"
            className="font-semibold underline underline-offset-2 hover:no-underline"
          >
            {access.locked ? "Choose a plan" : "See plans"}
          </Link>
        </div>
      )}

      {dialog === "welcome" && access.trialEndsAt && (
        <Dialog
          icon={<Clock className="h-4 w-4" />}
          title={`You have ${TRIAL_HOURS} hours of full access`}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>Start working</Button>
              <Button variant="secondary" onClick={closeAndOpenBilling}>
                See the plans
              </Button>
            </>
          }
        >
          <p>
            <span className="font-semibold text-ink">{organization.name}</span> is on the full
            product until{" "}
            <span className="font-mono">{endsAtLabel(access.trialEndsAt)}</span>. Write posts,
            generate the images and video, connect your channels and publish for real, none of it
            is a preview, and no card is needed to begin.
          </p>
          <p>
            When the {TRIAL_HOURS} hours are up the workspace stays exactly as you left it, but
            turns read-only until you pick a plan. Nothing is deleted and nothing publishes behind
            your back.
          </p>
        </Dialog>
      )}

      {dialog === "locked" && (
        <Dialog
          icon={<Lock className="h-4 w-4" />}
          title="Your free trial has ended"
          onClose={close}
          actions={
            <>
              <Button onClick={closeAndOpenBilling}>Choose a plan</Button>
              <Button variant="secondary" onClick={close}>
                Keep looking around
              </Button>
            </>
          }
        >
          <p>
            This workspace is read-only for now. Your posts, drafts, connected channels and history
            are all still here, you can read everything, but publishing, generating and editing are
            paused.
          </p>
          <p>Choosing a plan turns it all back on straight away.</p>
        </Dialog>
      )}
    </>
  );
}
