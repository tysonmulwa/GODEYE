# Meta App Review — resubmission

**Status:** rejected twice. This document is what to submit the third time, and
why the first two failed.

## What the rejections actually said

| Permission | Reason given |
|---|---|
| `instagram_business_content_publish` | **Use case allowed.** Screencast did not show the end-to-end flow |
| `instagram_business_basic` | Policy 1.6 — "not needed to support its core functionality" |
| `pages_show_list` | Policy 1.6 — same |
| `pages_read_engagement` | Policy 1.6 — same |

Read together these are not four problems. They are one problem with three
symptoms, plus one genuine mistake of ours.

**The reviewer approved the use case for `instagram_business_content_publish`.**
That is the important line in the whole rejection: Meta agrees that an app which
schedules and publishes Instagram posts on a business's behalf is a legitimate
thing. Only the *video* failed.

## Why the other three failed

### 1. We asked for a permission we do not use — our mistake, now fixed

`business_management` was in the Facebook scope list and used nowhere: no
`/businesses` call, no `business_id`, in either service. Policy 1.6 is literally
"not needed to support its core functionality", and an unused permission is the
clearest possible example. It colours a reviewer's reading of every other
permission in the same submission.

Removed in the same commit as this document. **Do not add it back.** If Business
Manager Page listing is ever needed, `pages_show_list` already covers the Pages
a person administers.

### 2. GODEYE has *two* login flows, and one screencast cannot show both

This is almost certainly why the Page permissions were rejected.

| Flow | Where it starts | Dialog | Permissions |
|---|---|---|---|
| **Facebook Pages** | Connections → "Connect Facebook" | `facebook.com/{version}/dialog/oauth` | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` |
| **Instagram** | Connections → "Connect Instagram" | `instagram.com/oauth/authorize` | `instagram_business_basic`, `instagram_business_content_publish` |

Different buttons, different dialogs, different APIs — `graph.facebook.com`
versus `graph.instagram.com`. They are not one integration with two halves.

The Instagram feedback says the reviewer watched an Instagram flow. So they
never saw a Facebook Page being connected or posted to, and from where they were
sitting `pages_show_list` and `pages_read_engagement` had no visible purpose.
That is not an unreasonable conclusion — it is the only one available from that
video.

**Submit two screencasts**, or one video with two clearly titled chapters, and
say in the notes which permissions each one covers.

### 3. `instagram_business_basic` is structurally required, and we did not say so

Publishing to Instagram is two calls:

```
POST https://graph.instagram.com/v21.0/{ig-user-id}/media
POST https://graph.instagram.com/v21.0/{ig-user-id}/media_publish
```

Both need `{ig-user-id}`, and `instagram_business_basic` is what returns it.
Without it, `instagram_business_content_publish` — whose use case Meta has
**already approved** — cannot make a single call.

Say exactly that, in one sentence, in the notes for `instagram_business_basic`.
It is a factual statement about Meta's own API and it resolves the contradiction
in their own decision.

---

## Notes to submit, per permission

Meta asks for three things each time: which functionality needs it, how the
integration works, and how it improves the end user's experience. Answer all
three, in that order, for every permission.

### `pages_show_list`

> **Functionality.** After a user connects Facebook, GODEYE shows them a list of
> the Pages they administer so they can choose which one to publish to. Without
> it we cannot show that list and the user cannot select a destination.
>
> **How it works.** On callback we call `GET /me/accounts` and store the Page id
> and Page access token for the Page the user picks. Screencast 1, 0:45.
>
> **End-user benefit.** The user picks their Page from a list of their own Pages
> instead of pasting a Page ID they would have to find in Meta Business Suite.

### `pages_manage_posts`

> **Functionality.** Publishing the post the user scheduled to their chosen Page
> at the chosen time. This is the product's core function.
>
> **How it works.** At the scheduled time our worker calls
> `POST /{page-id}/feed` (text/link) or `POST /{page-id}/photos` (image) with
> the stored Page access token. Screencast 1, 2:10.
>
> **End-user benefit.** They write once, choose a time, and the post appears —
> instead of having to be at their desk at 7am on a Sunday.

### `pages_read_engagement`

> **Functionality.** The Analytics page shows likes, comments and reach for
> posts GODEYE published, and the scheduling assistant uses that history to
> suggest better times to post.
>
> **How it works.** A daily job calls `GET /{post-id}/insights` for posts this
> app published, and stores the counts against the scheduled post. Screencast 1,
> 3:05 — the Analytics page with real figures.
>
> **End-user benefit.** They can see whether posting worked without opening a
> second tool, and the suggested times are based on their own results rather
> than generic advice.

### `instagram_business_basic`

> **Functionality.** Identifying which Instagram Business account has been
> connected, and displaying it so the user can confirm they connected the right
> one.
>
> **How it works.** After Instagram Login we call `GET /me` on
> `graph.instagram.com` to obtain the Instagram user id, username and profile
> picture. **This id is a required path parameter of every publishing call:**
> `POST /{ig-user-id}/media` and `POST /{ig-user-id}/media_publish`. Without
> `instagram_business_basic` the `instagram_business_content_publish` permission
> — whose use case has already been approved in this app — cannot make a single
> API call. Screencast 2, 0:50.
>
> **End-user benefit.** They see the account name and avatar they just
> connected, so an account connected by mistake is obvious immediately rather
> than after a post goes to the wrong place.

### `instagram_business_content_publish`

> **Functionality.** Publishing the scheduled post to the connected Instagram
> Business account.
>
> **How it works.** At the scheduled time our worker creates a media container
> with `POST /{ig-user-id}/media`, polls it until `status_code=FINISHED`, then
> publishes with `POST /{ig-user-id}/media_publish`. Screencast 2, 2:30 through
> 4:10, ending on the live post in the Instagram app.
>
> **End-user benefit.** The same as Pages: they schedule once and the post goes
> out on time, without them being present.

---

## Screencast 1 — Facebook Pages

Both videos: English UI, captions on, narrate what each click does. Do not cut
between screens — a jump is read as a missing step.

| | |
|---|---|
| 0:00 | GODEYE dashboard, signed in. Say what the product is in one sentence. |
| 0:15 | Connections page. Point at **Connect Facebook**. |
| 0:20 | **The full Facebook login dialog.** Do not skip it and do not start from an already-connected state — this is the specific thing they asked for. |
| 0:35 | **The permission consent screen, with the permissions visible.** Pause on it. Read them aloud. |
| 0:45 | Back in GODEYE: the list of Pages. Say "this list is `pages_show_list`." |
| 1:00 | Pick a Page. Show it connected. |
| 1:15 | Composer: write a post, attach an image, choose the Page. |
| 2:00 | Schedule it a minute out — or press Publish now. |
| 2:10 | **Switch to facebook.com and show the post live on the Page.** |
| 3:05 | Back in GODEYE: Analytics, with likes and comments on that post. Say "this is `pages_read_engagement`." |

## Screencast 2 — Instagram

| | |
|---|---|
| 0:00 | Same dashboard. |
| 0:15 | Connections page. Point at **Connect Instagram**, and say out loud that this is a **separate** integration using Instagram Login, not Facebook Login. |
| 0:25 | **The full Instagram login dialog**, then the consent screen with the permissions visible. |
| 0:50 | Back in GODEYE: the connected account's username and avatar. Say "this is `instagram_business_basic` — and its user id is what every publish call needs." |
| 1:10 | Composer: write a post, attach an image, choose the Instagram account. |
| 2:30 | Schedule a minute out, or Publish now. |
| 3:30 | Show the post appearing — the container being created, then published. |
| 4:10 | **Switch to the Instagram app or instagram.com and show the post live on the profile.** |

**The ending is the part that was missing.** Both videos must finish on the
post, live, on the platform. A video that stops at "Scheduled ✓" does not show
an end-to-end use case, and that is exactly the feedback given.

## Before pressing submit

- [ ] `business_management` is gone from the app's requested permissions in the
      Meta dashboard, not only from our code.
- [ ] The test user has a real Facebook Page **and** a real Instagram Business
      account, with at least one existing post each.
- [ ] The privacy policy at `/privacy` lists exactly the permissions requested —
      no more, no fewer. A permission described there and not requested is as
      confusing as the reverse.
- [ ] Both videos have captions and are in English.
- [ ] Every note above names a screencast and a timestamp.
- [ ] Neither video ends before the post is visible on the platform.
