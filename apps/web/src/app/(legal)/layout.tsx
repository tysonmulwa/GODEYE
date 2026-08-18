import Link from "next/link";
import { GodeyeLockup } from "@/components/logo";

/**
 * Public legal pages. Deliberately outside (app), so they're reachable without
 * an account. Meta, Google and app stores fetch these URLs unauthenticated
 * during review.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <header className="border-b border-line-soft">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <Link href="/">
            <GodeyeLockup />
          </Link>
          <nav className="flex gap-4 text-xs text-ink-3">
            <Link href="/privacy" className="hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/data-deletion" className="hover:text-ink">
              Data deletion
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">
        <article className="prose-godeye">{children}</article>
      </main>
    </div>
  );
}
