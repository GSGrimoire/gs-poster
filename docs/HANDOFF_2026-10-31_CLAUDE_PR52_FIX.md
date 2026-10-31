# GS Poster handoff: Claude-1 correction of PR #52, 31 October 2026

**Session:** Claude-1 | Implementer. **Branch:** `claude/fix-stuck-publishing-49` (PR [#52](https://github.com/GSGrimoire/gs-poster/pull/52)).
**Answers:** ChatGPT-2 Full review [5719185325](https://github.com/GSGrimoire/gs-poster/pull/52#pullrequestreview-5719185325) on head `d735ec7`, "Changes required".
**Read first:** `AGENTS.md`, `CLAUDE.md`, `docs/HANDOFF_2026-10-30_CHATGPT_2_INDEPENDENT_REVIEW.md` (PR #54), this file.

## Owner decision

Gus decided on 31 October: **a cancelled or abandoned post goes back to drafts, so it can be edited and posted later.** The reviewer's alternative (force a new post) was not chosen.

## What changed

1. `main` (#51, #53) was merged into the branch. No conflicts in behaviour.
2. `src/facebook-queue.ts`, `enqueueFacebookUpload`:
   - The insert now also requires `fb_post_id IS NULL` on the post.
   - On a conflicting row it resets the job (`media_ids='[]'`, `next_index=0`, `status='uploading'`, `started_at=NULL`, `error=NULL`) **only when the old row is `cancelled` or `done`**. One SQL statement, so the reset and the guard are atomic.
   - Rows in `uploading`, `busy`, `sending` or `failed` are never touched. Enqueue then still returns zero changes and the approval fails as before.
   - Enqueue is still only called after `claimForPublish` has moved a draft to `publishing` with a fresh PIN approval. Nothing here can be reached from cron, MCP or an unauthenticated route.
3. `abandonFacebookUpload` error text now tells the editor to check Facebook and move the post back to drafts.
4. `src/web.ts`: the queue notice is hidden on drafts, so an old cancelled row does not show as "Status: cancelled" on a draft. Redraft and abandon hints now say the post can be edited and approved again.
5. New `test/requeue-after-abandon.test.ts` (13 tests).

## Why `done` is safe to reset

A `done` row with `fb_post_id IS NULL` on a `publishing` post can only exist after one of the two human recovery paths:
- `restoreCancelledPost` checks via Graph that the old Facebook object is gone, then `reopenCancelledDraft` clears `fb_post_id` and `approved_at`.
- `backToDraft` refuses any post with `fb_post_id`.

Without this reset, every photo post that was scheduled, cancelled and reopened would fail on re-approval, because threshold 0 routes all photo posts through the queue. That was a second instance of the same bug.

## Ambiguous sends

Abandon still requires the editor's PIN and is still the only way out of `sending`. Redraft requires the PIN and the "I checked Facebook and confirm this post does not exist" checkbox. A fresh approval starts a **new** queue from zero; the old feed request is never resent and old media ids are discarded (orphaned unpublished photos on Meta's side are harmless).

## Evidence

- `npm run check`: 181 tests, 181 pass (local, head before push).
- `npx wrangler deploy --dry-run --outdir dist`: bundle OK.
- With the `src/facebook-queue.ts` change reverted, 7 of the 13 new tests fail. They test the fix, not themselves.
- Covered: 1/7/11 photos through abandon → redraft → edit → re-approve; abandon from `sending`; duplicate re-approval with a stale form; scheduled re-approval; enqueue refuses `uploading`/`busy`/`sending`/`failed`; `done` refused while `fb_post_id` is set; cancelled scheduled post reopened and re-approved; combined Facebook + Bluesky (active Bluesky blocks redraft, failed Bluesky allows it and resets to draft).
- Not covered here: concurrent cron claims during re-approval (claim fencing on `started_at` is unchanged and covered by `queue-safety.test.ts`), and any live Meta call.

## Not done by this session

- No merge, no deploy, no live action, no post approved or published. No secrets read.
- The seven stuck posts and the #32 live acceptance remain as described in the ChatGPT-2 handoff.

## Prompt for ChatGPT (copy as is)

> You are **ChatGPT-2 | Independent Reviewer** for GSGrimoire/gs-poster. Read `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md`, `docs/HANDOFF_2026-10-30_CHATGPT_2_INDEPENDENT_REVIEW.md` (on PR #54's branch), `docs/HANDOFF_2026-10-31_CLAUDE_PR52_FIX.md` and the GS Tools Hub review playbook.
>
> 1. **Merge PR #54** (docs only) if CI is green on its head. You authored it, so record that the owner asked a separate session to merge it; if your rules still forbid it, leave it and say so.
> 2. **Full review of PR #52** at its new exact head. Claude-1 answered your 30 October blocker. The owner decided that a cancelled or abandoned post must return to drafts so it can be edited and posted later. Check that `enqueueFacebookUpload` resets a job only from `cancelled` or `done`, only when the post has no `fb_post_id`, and never from `uploading`, `busy`, `sending` or `failed`. Walk approval, `claimForPublish`, queue claim and `sending` barrier, abandon, reconcile-stuck, redraft, restore-cancelled, page rendering and MCP tool registration. Confirm CI ran `npm run check` and `npx wrangler deploy --dry-run --outdir dist` on the exact head. Record a decision on the PR.
> 3. If #52 passes: merge it alone, then watch Deploy and live smoke until both succeed.
> 4. When #52 is live: walk the owner through recovering **one** stuck post, `p_mvppbkvn27705754cc`, using the runbook in your 30 October handoff. The owner checks Meta Business Suite, ticks the boxes and enters his own PIN. You verify each step with `get_post`, and after his re-approval verify with `get_post` and `list_page_posts` (published and scheduled) that exactly one matching Facebook post exists. Leave the other six until this one is proven.
> 5. **#32 native ChatGPT intake:** first check whether `import_chatgpt_files` and `check_uploads` are now exposed in your GS Poster tools. If not, tell the owner to refresh or reconnect the GS Poster app in ChatGPT and stop there. If they are, run the live acceptance with the test media from your 30 October handoff and compare digests.
> 6. Record every result, blocker and next step on issues #49, #52, #32 and in a new dated handoff `docs/HANDOFF_2026-10-31_CHATGPT_2.md` on its own branch and PR.
>
> Never publish, never approve on the owner's behalf, never weaken the approval guards, never print or ask for secrets or the PIN.
