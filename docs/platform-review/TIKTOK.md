# TikTok Content Posting API — resubmission

**Status:** rejected. Unlike the Meta rejection, **this one was about the app,
not the submission**, and the code has changed.

## What they said

> Your application did not follow our UX Guidelines. Please refer to point
> 2/3/4 under 'Required UX Implementation in Your App'... The demo video should
> show the complete end-to-end flow... and the ending must show that had been
> post under TikTok. Please showcase full interactions the privacy settings,
> interaction settings and Content Disclosure Setting

## Why it was correct

Points 2, 3 and 4 are all about **who decides**. GODEYE decided.

The publisher read `creator_info` at publish time, took the most public
visibility the account allowed, and posted with it. The creator was never
asked. `disable_comment`, `disable_duet` and `disable_stitch` appeared nowhere
in the codebase, and there was no content-disclosure toggle — so no
`brand_content_toggle` or `brand_organic_toggle` either.

There was no TikTok panel in the composer at all. A screencast could not have
shown these settings because they did not exist.

## What changed

| Point | Requirement | Where it now lives |
|---|---|---|
| **2** | Creator selects the privacy level, from the options their account allows, **with nothing pre-selected** | `tiktok-post-settings.tsx` — radio group from `creator_info.privacy_level_options`. Schedule is disabled until one is chosen, and the API refuses the request too |
| **3** | Comment / duet / stitch, with account-disallowed options shown **disabled** | Same panel. `comment_disabled`, `duet_disabled`, `stitch_disabled` from `creator_info` render the control greyed out with the reason |
| **4** | Content disclosure, the resulting label, and the policy links | Same panel. "Your brand" and "Branded content" → "Promotional content" / "Paid partnership", with links to the Branded Content Policy and the Music Usage Confirmation |

Plus TikTok's own rule that branded content cannot be private: **Only me** is
disabled while Branded content is on, and if it was already selected the choice
is *cleared* rather than moved to a more public audience. Silently widening who
can see a post is the same defect as choosing the audience in the first place.

**Nothing has a default.** A post that reaches the publisher with no recorded
choices is not published — it goes to the creator's TikTok drafts inbox, where
they make every one of those choices inside TikTok. A "sensible default" is the
rejected behaviour with a nicer name.

Evidence: `tiktok-post-settings.test.tsx` (18 assertions, each naming its
guideline point) and `test_tiktok_settings.py` (13).

## The screencast

The previous one failed on two counts: it did not show the settings, and it did
not end on a live post. Both are explicit in the feedback.

English UI, captions on, no cuts between screens, narrate every click.

| | |
|---|---|
| 0:00 | GODEYE dashboard, signed in. One sentence on what the product does. |
| 0:15 | Connections → **Connect TikTok**. |
| 0:20 | **The full TikTok login screen.** Do not start from an already-connected state. |
| 0:35 | **The consent screen, with the scopes visible.** Pause. Read them aloud. |
| 0:50 | Back in GODEYE — the connected TikTok account, by name. |
| 1:05 | Composer: write a caption, attach a video. |
| 1:30 | Select the TikTok destination. **The TikTok settings panel appears.** |
| 1:40 | **Point 2.** Say out loud: "nothing is selected — TikTok requires me to choose." Show that **Schedule is disabled**. Then pick an audience and show the button enable. |
| 2:10 | **Point 3.** Walk through Comment, Duet, Stitch. If the account disallows one, point at the greyed control and read the reason. Toggle one off and say what that means. |
| 2:40 | **Point 4.** Turn on "Your brand" → read the "Promotional content" label aloud. Turn on "Branded content" → read "Paid partnership", show the Branded Content Policy and Music Usage Confirmation links, and **show "Only me" becoming disabled**. Explain why. |
| 3:20 | Set the time a minute out. Press **Schedule**. |
| 3:40 | Wait for it to publish. Do not cut. |
| 4:00 | **Open the TikTok app and show the post live on the profile.** Open it and show the privacy setting and the disclosure label matching what was chosen in GODEYE. |

**The last row is the one that failed last time.** "The ending must show that
had been post under TikTok" — the video has to finish on the post, inside
TikTok, with the settings visibly matching what was selected. Anything shorter
is the same rejection again.

## Before pressing submit

- [ ] The test account is a **Personal or Creator** account, not Business.
      TikTok does not allow Business accounts to be private, and an unaudited
      app may only post to a private account — this is the
      `unaudited_client_can_only_post_to_private_accounts` error, which names
      the account and is really about the app.
- [ ] `TIKTOK_POST_MODE=direct`, so the screencast shows a real post and not a
      draft. A draft does not demonstrate the use case.
- [ ] The demo account has at least one existing post, so the profile does not
      look empty.
- [ ] Record on a screen where the whole settings panel is visible without
      scrolling; if it scrolls, scroll slowly and narrate.
- [ ] Watch it back and check every one of points 2, 3 and 4 is *spoken*, not
      just on screen. The reviewer is matching the video against a checklist.

## What is still ours to get wrong

`TIKTOK_AUDITED` is a claim about the outside world that nothing verifies. Set
it to `true` before approval actually lands and every post fails with an error
that blames the creator's account. Leave it `false` until the approval email
arrives — the publisher already reads TikTok's refusal and falls back, so the
cost of leaving it false is one wasted round trip per post, and the cost of
setting it early is every post failing.
