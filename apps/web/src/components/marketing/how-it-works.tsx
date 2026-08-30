import { Reveal, Section } from "./section";

/**
 * Four steps, each describing something the code does today.
 *
 * Step 4 is the one worth checking rather than assuming, because "a schedule
 * learned from your results" is exactly the sort of claim that is usually
 * aspirational. It is not: `tasks/planner.py` computes upcoming slots from
 * "preferred times, or engagement-driven best times", and `tasks/metrics.py`
 * is what collects the engagement it reads.
 */
const STEPS = [
  {
    n: "01",
    title: "Write one brief",
    body: "A sentence about what you want said. Not a caption. The point you are trying to make.",
  },
  {
    n: "02",
    title: "Adapted per channel",
    body: "A version for each destination. The same point, in the length and the voice that platform expects.",
  },
  {
    n: "03",
    title: "Images and video generated",
    body: "Stills rendered into video with licensed audio, at 30, 45 or 60 seconds, because TikTok will not take a silent photo post.",
  },
  {
    n: "04",
    title: "Published on a schedule learned from your results",
    body: "Autopilot reads when your own posts have actually performed and picks the slots from that. It chooses when, not whether.",
  },
] as const;

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title="One brief in. A week of posts out."
      className="border-t border-subtle"
    >
      <div className="relative">
        {/* The connecting line, desktop only. Behind the cards, and stopping
            short at both ends so it reads as a thread rather than a rule. */}
        <div
          aria-hidden
          className="absolute left-[12%] right-[12%] top-8 hidden h-px lg:block"
          style={{ background: "var(--brand-gradient)", opacity: 0.35 }}
        />
        <ol className="relative grid gap-10 lg:grid-cols-4 lg:gap-8">
          {STEPS.map((step, i) => (
            <li key={step.n}>
              <Reveal delay={i * 90}>
                {/* Vertical timeline on mobile: the marker column keeps the
                    steps visually threaded without the horizontal line. */}
                <div className="flex gap-4 lg:block">
                  <span className="m-glass flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl font-display text-[15px] font-semibold text-lilac lg:h-16 lg:w-16">
                    {step.n}
                  </span>
                  <div className="lg:mt-6">
                    <h3 className="text-[17px] font-semibold leading-snug text-primary">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-[14px] leading-relaxed text-secondary">{step.body}</p>
                  </div>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
