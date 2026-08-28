"use client";

import { useInView } from "@/lib/use-in-view";

/**
 * Shared section rhythm, so the page has one vertical scale rather than eight
 * slightly different ones.
 *
 * `clamp(5rem, 10vw, 9rem)` of vertical padding and a 1200px content column,
 * both from docs/design/tokens.md.
 */
export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  lede?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`px-6 py-[clamp(5rem,10vw,9rem)] ${className}`}>
      <div className="mx-auto max-w-[1200px]">
        {eyebrow || title ? (
          <header className="mb-12 max-w-3xl">
            {eyebrow ? (
              <p className="text-eyebrow uppercase text-muted">{eyebrow}</p>
            ) : null}
            {title ? (
              <h2 className="mt-4 text-display-lg font-display font-semibold text-primary">
                {title}
              </h2>
            ) : null}
            {lede ? <p className="mt-4 text-body-lg text-secondary">{lede}</p> : null}
          </header>
        ) : null}
        {children}
      </div>
    </section>
  );
}

/**
 * Fades its children up, once, when they first reach the viewport.
 *
 * `data-shown` rather than a class swap so the CSS in globals.css owns the
 * transition and the reduced-motion override in one place — see `.reveal`.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, shown } = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-shown={shown}
      className={`reveal ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
