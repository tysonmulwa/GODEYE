import { PlatformGlyph } from "./ui";

/**
 * Mock product screens for the marketing pages.
 *
 * Drawn in markup rather than captured as screenshots. A screenshot is out of
 * date the first time the UI moves, is wrong in whichever theme it was not
 * taken in, and turns into a blurry image on a phone. These are built from the
 * same tokens as the real product, so they follow it, render sharp at any
 * size, and stay right in dark mode.
 *
 * Everything here is illustrative. No claim is made that these are real
 * numbers from a real account.
 */

function Window({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2 rounded-full bg-ink-1/20" />
          <span className="size-2 rounded-full bg-ink-1/20" />
          <span className="size-2 rounded-full bg-ink-1/20" />
        </span>
        <span className="font-mono text-[11px] text-ink-3">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

const COMPOSER_PLATFORMS = ["TIKTOK", "INSTAGRAM", "FACEBOOK", "LINKEDIN"] as const;

/** One brief becoming a different caption per destination. */
export function ComposerPreview() {
  return (
    <Window title="composer">
      <p className="text-[11px] uppercase tracking-[0.12em] text-ink-3">Your brief</p>
      <p className="mt-1.5 text-[13px] leading-relaxed">
        New arrivals landed. Linen shirts, four colours.
      </p>
      <div className="mt-4 flex items-center gap-1.5">
        {COMPOSER_PLATFORMS.map((p) => (
          <PlatformGlyph key={p} platform={p} size={22} className="!rounded-[6px]" />
        ))}
        <span className="ml-1 font-mono text-[11px] text-ink-3">4 versions</span>
      </div>
      <div className="mt-4 space-y-2">
        {[
          { p: "TIKTOK" as const, t: "linen season is officially open 🌾 four colours, gone fast" },
          { p: "LINKEDIN" as const, t: "Our new linen range is in stock, made from certified flax." },
        ].map((row) => (
          <div key={row.p} className="flex gap-2.5 rounded-lg border border-line p-2.5">
            <PlatformGlyph platform={row.p} size={20} className="!rounded-[6px] shrink-0" />
            <p className="text-[12px] leading-relaxed text-ink-2">{row.t}</p>
          </div>
        ))}
      </div>
    </Window>
  );
}

const SLOTS = [
  { day: "MON", time: "09:00", p: "INSTAGRAM" as const, state: "published" },
  { day: "MON", time: "18:30", p: "TIKTOK" as const, state: "published" },
  { day: "TUE", time: "12:00", p: "FACEBOOK" as const, state: "scheduled" },
  { day: "WED", time: "08:15", p: "LINKEDIN" as const, state: "scheduled" },
];

/** The week, filled in by autopilot. */
export function CalendarPreview() {
  return (
    <Window title="calendar">
      <div className="space-y-2">
        {SLOTS.map((s) => (
          <div key={s.day + s.time} className="flex items-center gap-3">
            <span className="w-9 font-mono text-[11px] text-ink-3">{s.day}</span>
            <span className="font-mono text-[11px] text-ink-2">{s.time}</span>
            <PlatformGlyph platform={s.p} size={20} className="!rounded-[6px]" />
            <span
              className={`ml-auto rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                s.state === "published"
                  ? "bg-emerald-500/13 text-emerald-600 dark:text-emerald-400"
                  : "bg-ink-1/10 text-ink-3"
              }`}
            >
              {s.state}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 border-t border-line pt-3 text-[11px] text-ink-3">
        Times chosen from when this account&apos;s own posts have performed.
      </p>
    </Window>
  );
}

const CHANNELS = [
  "TIKTOK",
  "INSTAGRAM",
  "FACEBOOK",
  "LINKEDIN",
  "X",
  "TELEGRAM",
  "REDDIT",
  "DISCORD",
] as const;

/** Everything it publishes to. */
export function ChannelsPreview() {
  return (
    <Window title="connections">
      <div className="grid grid-cols-4 gap-3">
        {CHANNELS.map((p) => (
          <div key={p} className="flex flex-col items-center gap-1.5">
            <PlatformGlyph platform={p} size={30} className="!rounded-[8px]" />
            <span className="font-mono text-[9px] uppercase text-ink-3">{p}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 border-t border-line pt-3 text-[11px] text-ink-3">
        Connect once. Credentials are encrypted at rest.
      </p>
    </Window>
  );
}
