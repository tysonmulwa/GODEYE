"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { TIKTOK_PRIVACY_LEVELS, type TikTokPrivacyLevel } from "@godeye/shared";
import { api } from "@/lib/api";

/**
 * The publishing choices TikTok requires the creator to make, in our app,
 * before a post is scheduled.
 *
 * TikTok's Content Sharing Guidelines, "Required UX Implementation in Your
 * App". GODEYE was rejected because it had none of this: the server read
 * `creator_info` at publish time and picked the most public visibility the
 * account allowed. Points 2 to 4 are all about *who decides*, and the answer
 * has to be the creator.
 *
 *   2. **Privacy level.** Selected from the options this account actually
 *      offers, with **nothing pre-selected**, and publishing blocked until it
 *      is chosen.
 *   3. **Interaction settings.** Comment, duet and stitch — and where the
 *      creator's own account forbids one, the control is shown **disabled**
 *      rather than hidden, so they can see it is their setting and not ours.
 *   4. **Content disclosure.** Whether the post promotes their own brand, a
 *      third party's, or neither, with the compliance text TikTok specifies and
 *      links to the policies it names.
 *
 * Everything offered here comes from `creator_info` on this connection. The
 * component never widens what TikTok reports.
 */

export interface TikTokSettings {
  privacyLevel: TikTokPrivacyLevel | null;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandOrganic: boolean;
  brandedContent: boolean;
}

export const EMPTY_TIKTOK_SETTINGS: TikTokSettings = {
  // null, not a default. TikTok requires the creator to pick with nothing
  // pre-selected, and this is where that starts.
  privacyLevel: null,
  disableComment: false,
  disableDuet: false,
  disableStitch: false,
  brandOrganic: false,
  brandedContent: false,
};

interface CreatorInfo {
  creatorNickname: string | null;
  creatorUsername: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
}

/** TikTok's own wording, so the label matches what the creator sees in TikTok. */
const PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

/**
 * Ready to publish?
 *
 * Exported so the composer's Schedule button and the tests agree on one rule
 * rather than two. Two answers to "can this be posted" is how a disabled button
 * and a rejected request end up disagreeing.
 */
export function tiktokSettingsComplete(s: TikTokSettings): boolean {
  if (!s.privacyLevel) return false;
  // TikTok rejects branded content on a private post: a paid partnership only
  // the creator can see cannot be disclosed to anyone.
  if (s.brandedContent && s.privacyLevel === "SELF_ONLY") return false;
  return true;
}

/** The disclosure line TikTok requires, which depends on what is toggled. */
export function disclosureLabel(s: TikTokSettings): string | null {
  if (s.brandedContent && s.brandOrganic) return "Paid partnership";
  if (s.brandedContent) return "Paid partnership";
  if (s.brandOrganic) return "Promotional content";
  return null;
}

export function TikTokPostSettingsPanel({
  connectionId,
  value,
  onChange,
}: {
  connectionId: string;
  value: TikTokSettings;
  onChange: (next: TikTokSettings) => void;
}) {
  const {
    data: info,
    isLoading,
    error,
  } = useQuery<CreatorInfo>({
    queryKey: ["tiktok-creator-info", connectionId],
    queryFn: () => api(`/connections/${connectionId}/tiktok/creator-info`),
    // The creator can change these in TikTok while the composer is open, and a
    // stale menu offers something TikTok will refuse.
    staleTime: 60_000,
    retry: false,
  });

  const set = <K extends keyof TikTokSettings>(key: K, next: TikTokSettings[K]) =>
    onChange({ ...value, [key]: next });

  /**
   * Turning on Branded content while "Only me" is selected clears the
   * selection rather than silently changing it.
   *
   * Silently switching to a more public audience because of a disclosure
   * toggle would be the app choosing a visibility for somebody — the exact
   * thing this whole panel exists to stop.
   */
  useEffect(() => {
    if (value.brandedContent && value.privacyLevel === "SELF_ONLY") {
      onChange({ ...value, privacyLevel: null });
    }
  }, [value, onChange]);

  if (isLoading) {
    return (
      <p className="text-sm text-muted" role="status">
        Checking what your TikTok account allows…
      </p>
    );
  }

  if (error || !info) {
    return (
      <p className="text-sm text-danger" role="alert">
        TikTok would not tell us what this account allows, so this post cannot be
        scheduled yet. Reconnect TikTok in Connections and try again.
      </p>
    );
  }

  const offered = TIKTOK_PRIVACY_LEVELS.filter((level) =>
    info.privacyLevelOptions.includes(level),
  );

  return (
    <section
      aria-labelledby="tiktok-settings-heading"
      className="space-y-5 rounded-lg border border-token p-4"
    >
      <header>
        <h3 id="tiktok-settings-heading" className="text-sm font-medium">
          TikTok settings
          {info.creatorNickname ? (
            <span className="ml-2 font-normal text-muted">for {info.creatorNickname}</span>
          ) : null}
        </h3>
        <p className="mt-1 text-xs text-muted">
          TikTok requires you to choose these yourself before a post can be published.
        </p>
      </header>

      {/* ---------------------------------------------------------------
          Point 2. Who can see this post.
          Radio, not a select: a select always shows a value, and TikTok
          requires nothing to be pre-selected.
      --------------------------------------------------------------- */}
      <fieldset>
        <legend className="text-sm font-medium">Who can see this post</legend>
        <p className="mt-1 text-xs text-muted">
          Only the options your TikTok account allows are listed.
        </p>
        <div className="mt-2 space-y-2">
          {offered.map((level) => {
            const blocked = value.brandedContent && level === "SELF_ONLY";
            return (
              <label
                key={level}
                className={`flex items-start gap-2 text-sm ${blocked ? "opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="tiktok-privacy"
                  value={level}
                  checked={value.privacyLevel === level}
                  disabled={blocked}
                  onChange={() => set("privacyLevel", level)}
                  className="mt-0.5"
                />
                <span>
                  {PRIVACY_LABELS[level]}
                  {blocked ? (
                    <span className="block text-xs text-muted">
                      Not available while Branded content is on. A paid partnership has to be
                      visible to someone.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
        {offered.length === 0 ? (
          <p className="mt-2 text-sm text-danger" role="alert">
            TikTok reports no available audiences for this account. That usually means the
            account is under review.
          </p>
        ) : null}
      </fieldset>

      {/* ---------------------------------------------------------------
          Point 3. Interaction settings.
          An option the creator's own account forbids is shown DISABLED with
          the reason, not hidden — so it reads as their setting, not ours.
      --------------------------------------------------------------- */}
      <fieldset>
        <legend className="text-sm font-medium">Allow people to</legend>
        <div className="mt-2 space-y-2">
          {(
            [
              ["Comment", "disableComment", info.commentDisabled],
              ["Duet", "disableDuet", info.duetDisabled],
              ["Stitch", "disableStitch", info.stitchDisabled],
            ] as const
          ).map(([label, key, accountDisabled]) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                // The state is "disable X", the control reads "allow X".
                checked={!accountDisabled && !value[key]}
                disabled={accountDisabled}
                onChange={(e) => set(key, !e.target.checked)}
                className="mt-0.5"
              />
              <span className={accountDisabled ? "opacity-50" : ""}>
                {label}
                {accountDisabled ? (
                  <span className="block text-xs text-muted">
                    Turned off in your TikTok account settings.
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* ---------------------------------------------------------------
          Point 4. Content disclosure, with the text and links TikTok names.
      --------------------------------------------------------------- */}
      <fieldset>
        <legend className="text-sm font-medium">Disclose post content</legend>
        <p className="mt-1 text-xs text-muted">
          Turn this on if this post promotes a brand, product or service.
        </p>

        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.brandOrganic}
            onChange={(e) => set("brandOrganic", e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Your brand
            <span className="block text-xs text-muted">
              You are promoting yourself or your own business. This post will be labelled as
              Promotional content.
            </span>
          </span>
        </label>

        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.brandedContent}
            onChange={(e) => set("brandedContent", e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Branded content
            <span className="block text-xs text-muted">
              You are promoting another brand or a third party. This post will be labelled as
              Paid partnership. This cannot be turned on for a post only you can see.
            </span>
          </span>
        </label>

        {/* TikTok requires the resulting label and the policy links to be shown. */}
        {disclosureLabel(value) ? (
          <p className="mt-3 text-xs" role="status">
            Your post will be labelled &ldquo;{disclosureLabel(value)}&rdquo;. By posting, you
            agree to TikTok&rsquo;s{" "}
            {value.brandedContent ? (
              <>
                <a
                  href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Branded Content Policy
                </a>{" "}
                and{" "}
              </>
            ) : null}
            <a
              href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Music Usage Confirmation
            </a>
            .
          </p>
        ) : null}
      </fieldset>
    </section>
  );
}
