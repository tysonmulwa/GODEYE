import { CalendarPreview, ComposerPreview } from "@/components/product-preview";
import { Reveal, Section } from "./section";

/**
 * The capability grid.
 *
 * Copy is the six blocks that were already on this page and already vetted —
 * every one describes shipped behaviour. The SEO block has been pulled out into
 * its own section rather than repeated here.
 *
 * Each tile carries a small coded visual instead of an icon in a circle. They
 * are drawn in markup for the same reason `product-preview.tsx` is: a
 * screenshot is out of date the first time the UI moves, wrong in whichever
 * theme it was not captured in, and blurry on a phone.
 */

/** A caption becoming several. */
function VariantStack() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {[
        { w: "w-full", tone: "bg-violet/70" },
        { w: "w-[82%]", tone: "bg-lilac/60" },
        { w: "w-[64%]", tone: "bg-cyan/50" },
      ].map((row) => (
        <div key={row.w} className={`h-1.5 rounded-full ${row.w} ${row.tone}`} />
      ))}
    </div>
  );
}

/** Stills becoming a video with a track under it. */
function VideoStrip() {
  const bars = [7, 12, 9, 16, 11, 18, 8, 14, 10, 17, 6, 13, 9, 15];
  return (
    <div aria-hidden>
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-9 flex-1 rounded-md border border-subtle"
            style={{
              background: `linear-gradient(${140 + i * 25}deg, rgb(124 107 247 / 0.35), rgb(34 211 238 / 0.18))`,
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex h-5 items-end gap-[3px]">
        {bars.map((h, i) => (
          <span
            key={i}
            className="flex-1 rounded-sm bg-cyan/45"
            style={{ height: `${h}px` }}
          />
        ))}
      </div>
    </div>
  );
}

/** A catalogue read off a shop. */
function CatalogueChips() {
  return (
    <div className="flex flex-wrap gap-1.5" aria-hidden>
      {["Linen shirt", "$48", "4 colours", "S–XL", "In stock"].map((chip) => (
        <span
          key={chip}
          className="rounded-md border border-subtle bg-elevated px-2 py-1 text-[11px] text-secondary"
        >
          {chip}
        </span>
      ))}
    </div>
  );
}

/** A price claim being refused. */
function RuleCheck() {
  return (
    <div className="space-y-1.5" aria-hidden>
      {[
        { text: "Was $80, now $48", ok: false },
        { text: "Only 2 left!", ok: false },
        { text: "Lowest price in 30 days: $52", ok: true },
      ].map((r) => (
        <div key={r.text} className="flex items-center gap-2 text-[11px]">
          <span className={r.ok ? "text-published" : "text-failed"}>{r.ok ? "✓" : "✕"}</span>
          <span className={r.ok ? "text-secondary" : "text-muted line-through"}>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

function Tile({
  title,
  body,
  visual,
  className = "",
  delay = 0,
}: {
  title: string;
  body: string;
  visual?: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className={className}>
      <article className="hairline flex h-full flex-col rounded-2xl bg-raised p-6">
        <h3 className="text-[16px] font-semibold leading-snug text-primary">{title}</h3>
        <p className="mt-2.5 flex-1 text-[14px] leading-relaxed text-secondary">{body}</p>
        {visual ? <div className="mt-6">{visual}</div> : null}
      </article>
    </Reveal>
  );
}

export function FeatureBento() {
  return (
    <Section
      id="what-it-does"
      eyebrow="What it does"
      title="Six jobs somebody was doing by hand"
      className="border-t border-subtle"
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {/* The large tile. One per grid — a bento with two focal points has
            none. */}
        <Reveal className="lg:col-span-2 lg:row-span-2">
          <article className="hairline flex h-full flex-col rounded-2xl bg-raised p-6 sm:p-8">
            <h3 className="max-w-lg text-heading font-display font-semibold text-primary">
              Writes for each platform, not once for all of them
            </h3>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-secondary">
              A caption that works on LinkedIn is the wrong length and the wrong voice for
              TikTok. GODEYE writes a version per destination from one brief, keeping the
              point and changing the delivery.
            </p>
            <div className="mt-8">
              <ComposerPreview />
            </div>
          </article>
        </Reveal>

        <Tile
          delay={80}
          title="Publishes on its own, when your audience is awake"
          body="Connect your channels once. Autopilot builds a schedule from when your posts have actually performed, then sends them without anyone pressing anything."
          visual={<CalendarPreview />}
        />

        <Tile
          delay={160}
          title="Turns your photographs into video with sound"
          body="Short-form video reaches further than a still, and TikTok will not accept a silent photo post at all. GODEYE renders your images into video carrying your own licensed track."
          visual={<VideoStrip />}
        />

        <Tile
          delay={40}
          title="Reads your shop and posts what you sell"
          body="Point it at your website and it reads the catalogue: names, prices, sizes, colours and photographs. Then it writes posts from them. New products announce themselves."
          visual={<CatalogueChips />}
        />

        <Tile
          delay={120}
          title="Knows what it is not allowed to say"
          body="Selling into the EU or UK means a price reduction must state the lowest price of the previous thirty days, and invented scarcity is banned outright. GODEYE writes neither."
          visual={<RuleCheck />}
        />

        <Tile
          delay={200}
          title="One brief becomes every version"
          body="You write the thought once. Every platform gets the version it expects, and you can edit any of them before a single thing goes out."
          visual={<VariantStack />}
        />
      </div>
    </Section>
  );
}
