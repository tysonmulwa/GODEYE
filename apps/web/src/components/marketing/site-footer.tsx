import Link from "next/link";
import { GodeyeEmblem } from "@/components/logo";

/**
 * The footer.
 *
 * Every link points at a page that exists. There is no status page and no
 * /docs route, so neither is listed: a dead link in the footer of a page whose
 * whole job is to look trustworthy costs more than a missing column.
 *
 * The two integration pages sit in Essentials alongside Privacy and Terms.
 * They are reference material a visitor goes looking for once, in the same
 * spirit as the legal pages, rather than part of the primary path through the
 * product.
 *
 * The contact address is the one already published on /privacy, /terms and
 * /data-deletion, so this is the same address in one more place rather than a
 * new disclosure.
 */
const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/#what-it-does", label: "What it does" },
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#findable", label: "SEO" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "Essentials",
    links: [
      { href: "/integrations/tiktok", label: "TikTok" },
      { href: "/integrations/meta", label: "Facebook and Instagram" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/data-deletion", label: "Data deletion" },
    ],
  },
  {
    heading: "Account",
    links: [
      { href: "/register", label: "Start free" },
      { href: "/login", label: "Sign in" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-subtle px-6 py-14">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex flex-col gap-12 lg:flex-row lg:justify-between">
          <div className="max-w-xs">
            <span className="inline-flex items-center gap-2.5 text-primary">
              <GodeyeEmblem variant="compact" className="h-10 w-10 text-primary" />
              <span className="font-brand text-[16px] tracking-[0.2em]">GODEYE</span>
            </span>
            <p className="mt-4 text-[14px] leading-relaxed text-muted">
              Marketing that runs without you in the room.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:gap-16">
            {COLUMNS.map((col) => (
              <div key={col.heading}>
                <h2 className="text-eyebrow uppercase text-muted">{col.heading}</h2>
                {/* min-h-11 rather than padding arithmetic: a footer link is
                    ~17px of text, and the 44px target is the one thing a footer
                    reliably fails on a phone. The minimum height also supplies
                    the row rhythm, so there is no separate gap. */}
                <ul className="mt-2">
                  {col.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="flex min-h-11 items-center text-[14px] text-secondary transition-colors hover:text-primary"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-subtle pt-6 text-[13px] text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} GODEYE</span>
          <a
            href="mailto:tysonmulwa25@gmail.com"
            className="inline-flex min-h-11 items-center transition-colors hover:text-secondary"
          >
            Contact
          </a>
        </div>
      </div>
    </footer>
  );
}
