# GS Poster handoff: approved Instagram publishing (5 November 2026)

**Session:** Claude-1 | Implementer. **Branch:** `claude/zen-wright-ob7ogy`. **Base:** `main` `d44841f`.
**Review depth:** Full. This adds a publishing path, a public media route and new PIN-gated actions.
**Owner go-ahead:** Gus approved the plan and the new hard rule in the Claude session on 5 November 2026: Instagram publishes only after his PIN approval, from cron, with a one-way send barrier and short-lived media links.

## What it does

- A draft with an Instagram card gets an **Instagram** checkbox in the approval card, but only when `IG_USER_ID` (numeric) and `FB_PAGE_TOKEN` are set. Until then Instagram stays the manual download it is today.
- Approving with the PIN and the explicit consent tick creates one `instagram_jobs` row. It freezes the caption, frame, photo items or Reel video. Later draft edits never change it. Nothing is sent in the approval request.
- Cron (`processInstagramBatch`, every minute) claims one due job with a three-minute lease. Every write is fenced by that lease.
  1. `preparing`: up to five carousel photo containers per run, each checkpointed, then the parent container (`CAROUSEL`, `REELS` or a single image with the caption).
  2. `processing`: reads `status_code` until `FINISHED`. `ERROR`, `EXPIRED`, or more than two hours, fails without publishing.
  3. `sending`: a one-way barrier, then `media_publish` once. A lost or unclear answer, or any error after the barrier, ends as `failed` with `ambiguous = 1` and is never resent.
  4. `published` stores the media id and permalink, and deletes the media links.
- Meta fetches media from `/instagram/media/<token>.jpg|.mp4`. The route is public by design. Tokens are random, stored only as SHA-256, expire after six hours and work only while the job is `preparing`, `processing` or `sending`. JPEGs are rendered from the frozen frame and crop with the existing `renderInstagram`. Videos stream through `fetchVideo`. Private R2 and GitHub sources are never exposed.
- PIN-gated controls in the Instagram card: cancel while waiting, retry or stop after a failure before the send, and close an unclear result. Closing also needs "I checked the GS Grimoire Instagram and this post is not there".
- Cancelling a scheduled post, moving it in the calendar, Facebook reporting it removed, or deleting the draft each stop or move a waiting Instagram job. A job past the barrier is never touched.
- `check_setup` reports `instagram: { ok, username | error }`. MCP tools still cannot publish; their descriptions now say only Gus's PIN approval can send to Instagram.

## Entry points and trust boundaries

| Entry | Who | Gate |
| --- | --- | --- |
| `POST /post/:id/approve` with `target_instagram` | signed-in allowlisted owner | same-origin, CSRF, PIN and lockout, version fence, `confirm_instagram`, plan check, media readable |
| `POST /post/:id/instagram-cancel` / `-retry` / `-close` | owner | same-origin, CSRF, PIN and lockout; close also needs `confirmed_not_on_instagram` |
| `GET /instagram/media/...` | Meta's fetcher, unauthenticated | hashed, expiring token; job must be active; GET/HEAD only; no-store, noindex, nosniff |
| cron `scheduled` | Worker | lease claim; only `scheduled` (due), `preparing`, `processing` |

## Tests

`test/instagram-publish.test.ts` (14 tests, real D1 and a mock Graph API) covers: the manual plan until connected; content and house-rule checks; the approval version fence and freezing; no second approval while a job exists; replacement after cancel; carousel order and checkpoints; the five-per-run budget for 10 photos; single image and Reel; waiting on `IN_PROGRESS`; `ERROR` and the two-hour timeout; an unclear send never resent and closed only by the owner path; retry before the barrier; overlapping cron runs; not connected means no calls; calendar move; deleted draft; media links only while active.

`test/instagram-publish-route.test.ts` (5 tests, the production web router in workerd) covers: the approval card offering Instagram; wrong PIN, missing consent and cross-site requests creating no job; cancel needing the PIN and showing in the card; close needing the tick and PIN, with direct retry refused; the public route refusing unknown, short or wrong-extension links.

`npm run check`: 361 passed, 0 failed. The `wrangler` dry-run passes. `git diff --check origin/main...HEAD` is clean.

## Not verified

There have been no real Meta calls. Real Instagram container processing, Meta fetching the rendered JPEG or MP4 from the public route, the permission scopes on the real Page token and a live Reel are all untested. Gus will see them on the first real post (the Archive Arena Instagram stage, step 10).

## For the reviewer

- Check that nothing besides the PIN-gated approval can insert into `instagram_jobs`, and nothing besides cron can call `media_publish`.
- Check the `sending` barrier: no code path moves `sending` or ambiguous `failed` back to an automatic state.
- Check the public media route can't serve anything except a frozen item of an active job.
- An Instagram-only approval leaves the post itself a `draft` (like TikTok-only). The Instagram card shows the job; a second approval is refused while it exists.

## Review round 1 (ChatGPT-2, head `5d7682f`): fixes

- **F1, deletion.** `deletePost` now refuses, in the same `DELETE` statement, any post with an Instagram job that isn't `cancelled`: waiting, preparing, processing, sending, failed, unclear or published. That is the only post-deletion path (MCP `delete_draft`), and it now says Gus approved the post for Instagram. After the PIN-gated cancel, deletion works again. The `instagram_jobs` definition moved to `db.ts` (`INSTAGRAM_JOBS_DDL`, created by `ensureSchema`) so the guard always has its table.
- **F2, calendar moves.** `updateCalendarTime` moves the post's time and a waiting job's `due_at` in one D1 batch. The post update refuses while the job is preparing, processing or sending, and the job update requires the post's new version. A cron claim lands either before (refused) or after (the job already has the new time). `reschedulePost` also refuses before any Facebook call once Instagram has started. The separate later `moveScheduledInstagram` write is removed.
- **F3, interrupted sends.** The barrier now takes its own ten-minute send lease. Cron turns an expired `sending` into `failed` with `ambiguous = 1`, never resending it; the owner closes it with the PIN and "I checked Instagram". A late answer from Meta:
  - while the job is still unclear, it records the real post (`published`, media id);
  - after the owner has decided, it changes nothing and the media id is kept in the audit log.
  - If saving a returned media id fails, the job becomes unclear and its error names the id.
- **Tests added:**
  - F1: `handleDeleteDraft` in every job state, unapproved deletion still allowed, deletion after cancel, and a delete racing a cron claim.
  - F2: refusal with nothing changed (draft and approved mixed schedule, with no Facebook call), the in-transaction guard, and a stale version moving neither.
  - F3: a crash right after the barrier, a send still inside its lease, a late answer before and after the owner's decision, and a failed media-id write.
  - Production router: successful Instagram-only and mixed Facebook plus Instagram approvals, using private uploads in a local R2 bucket.
- **Checks:** `npm run check` gave 371 passed, 0 failed, three runs in a row. The `wrangler` dry-run passes and `git diff --check` is clean.
