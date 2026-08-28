import { Section } from "./section";

/**
 * Real objections, answered short.
 *
 * ## Why `<details>` and not a React accordion
 *
 * It is keyboard-operable, screen-reader-announced and open/closed-stateful
 * with no JavaScript at all — so it works before hydration, works if the bundle
 * fails, and costs nothing on a route with a budget. A hand-rolled accordion
 * would need `aria-expanded`, `aria-controls`, roving focus and a state hook to
 * arrive at the same place, worse.
 *
 * ## Why the answers are short
 *
 * Buyers increasingly ask an assistant rather than a search box, and an
 * assistant quotes a passage it can lift whole. A question with a two-sentence
 * answer is good material for that; prose that unfolds an argument across a
 * section is not. The `FAQPage` JSON-LD on the page is generated from this
 * exact array, so the two cannot drift.
 */
export function Faq({ items }: { items: readonly { q: string; a: string }[] }) {
  return (
    <Section
      id="faq"
      eyebrow="Common questions"
      title="The things people actually ask"
      className="border-t border-subtle"
    >
      <div className="max-w-3xl divide-y divide-subtle border-y border-subtle">
        {items.map((item) => (
          <details key={item.q} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[16px] font-medium text-primary [&::-webkit-details-marker]:hidden">
              {item.q}
              <span
                aria-hidden
                className="relative h-4 w-4 shrink-0 text-muted transition-transform duration-[--dur-mid] group-open:rotate-45"
              >
                {/* A plus that becomes a cross. Two rules, no icon import. */}
                <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-current" />
                <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-current" />
              </span>
            </summary>
            <p className="pb-5 pr-10 text-[15px] leading-relaxed text-secondary">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
