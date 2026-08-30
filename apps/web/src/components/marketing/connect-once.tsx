import { PLATFORM_MARKS } from "@/components/platform-marks";
import { Reveal, Section } from "./section";

/**
 * The channel row.
 *
 * One line per channel saying what GODEYE actually does there — not a logo
 * wall. A row of marks with no text is decoration; the useful information is
 * that the thing posts *video* to TikTok and *Reels* to Instagram, because
 * that is what a reader is trying to find out.
 *
 * Every line here describes shipped behaviour. The TikTok line in particular
 * is worded against what the publisher does today: it renders stills into
 * video because TikTok will not accept a silent photo post.
 */
const CHANNELS = [
  { key: "TIKTOK", name: "TikTok", does: "Video posts, with the privacy and disclosure settings you choose" },
  { key: "INSTAGRAM", name: "Instagram", does: "Feed posts and Reels to a Business account" },
  { key: "FACEBOOK", name: "Facebook", does: "Posts, photos and Reels to a Page you administer" },
  { key: "LINKEDIN", name: "LinkedIn", does: "Text and image posts to a profile or company page" },
  { key: "X", name: "X", does: "Posts with images, threaded when the copy runs long" },
  { key: "REDDIT", name: "Reddit", does: "Link and text submissions to a subreddit you pick" },
  { key: "TELEGRAM", name: "Telegram", does: "Messages and media to a channel your bot administers" },
  { key: "DISCORD", name: "Discord", does: "Messages and media to a server channel" },
] as const;

export function ConnectOnce() {
  return (
    <Section
      id="channels"
      eyebrow="Your channels"
      title="Press connect, authorize, done"
      lede="No developer keys to hunt down, no tokens to paste. Connecting a channel is a redirect and an authorization, the same as signing into anything else."
    >
      <div className="grid gap-px overflow-hidden rounded-2xl border border-subtle bg-subtle sm:grid-cols-2">
        {CHANNELS.map((c, i) => (
          <Reveal key={c.key} delay={i * 40}>
            <div className="flex h-full items-start gap-4 bg-raised p-5">
              <span className="m-glass flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary">
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden>
                  {PLATFORM_MARKS[c.key]}
                </svg>
              </span>
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold text-primary">{c.name}</h3>
                <p className="mt-1 text-[14px] leading-relaxed text-secondary">{c.does}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
