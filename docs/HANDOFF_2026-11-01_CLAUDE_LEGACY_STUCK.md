# GS Poster handoff: legacy stuck posts without approved_at, 1 November 2026

**Session:** Claude-1 | Implementer. **Branch:** `claude/legacy-stuck-recovery`. **Base:** `343729c` (production).
**Answers:** ChatGPT-2's live-acceptance finding on issue #49 and PR #52 (1 November).

## Diagnosis (read-only D1, nothing changed)

All seven stuck posts have the same shape:

| id | status | approved_at | fb_post_id | images | queue job | Bluesky |
|---|---|---|---|---|---|---|
| p_mvppbkvn27705754cc | publishing | NULL | NULL | 7 | none | none |
| p_mvppboxrb276c1eb88 | publishing | NULL | NULL | 7 | none | none |
| p_mvppbqdc3cec3cdf0e | publishing | NULL | NULL | 7 | none | none |
| p_mvppbta50b65315858 | publishing | NULL | NULL | 7 | none | none |
| p_mvppbuywca87d7ec9d | publishing | NULL | NULL | 7 | none | none |
| p_mvpqp2hmbf680b3b85 | publishing | NULL | NULL | 7 | none | none |
| p_mvpqpf0u6d853169ab | publishing | NULL | NULL | 7 | none | none |

No other post is `publishing` without `approved_at`. The audit trail for `p_mvppbkvn27705754cc` holds only `drafted`; no approval or failure was ever logged.

**Root cause:** the version live on 26 October (v0.1.0, `a57e5bf`) claimed `draft -> publishing` with `updatePost(..., {status:"publishing"})`. It wrote `approved_at` only after Facebook had answered. The approval request died during the photo uploads, so the post stayed in `publishing` without an approval time. Current `claimForPublish` sets both atomically, so this shape is legacy-only. `isStuckPublishing` required `approved_at`, which is why no recovery form appeared.

## Correction

- `isStuckPublishing` no longer requires `approved_at`. It still requires:
  - `publishing`
  - Facebook enabled
  - no Facebook id
  - an age of at least 15 minutes
  - no queue job
- It also now refuses any Bluesky target that is scheduled, publishing or published, or that holds a uri, cid, card_uri or permalink.
- The `reconcileStuckPublishing` SQL drops `approved_at IS NOT NULL`. It adds the same Bluesky guard, so the check and the write are one atomic UPDATE. It keeps the version fence, age, Facebook-id and no-job conditions.
- No approval time is backfilled. A legacy record stays `approved_at = NULL` through `failed` and `draft`, and gets an approval time only from the owner's fresh PIN approval.
- The error text, the audit detail (`legacy record without approved_at`) and a hint on the page say it was approved with an older version.

## Evidence

- `test/legacy-stuck-route.test.ts` drives the real `handleWeb` in workerd. Miniflare `outboundService` records every outbound request, and a control test proves the recorder catches them. The tests cover:
  - the form renders for the legacy shape, with the hint
  - refusals: no session, non-allowlisted login, cross-origin, forged CSRF, wrong PIN, missing confirmation, lockout (429 even with the right PIN)
  - more refusals: a recent post, a stale version, a Facebook id, a queue job, a Bluesky target that is scheduled, publishing or published
  - the full path: reconcile → `failed` (no approval invented, one audit entry, the duplicate gets 409) → redraft (PIN) → editor draft with the 27 Oct slot cleared → save without PIN (stays unapproved) → approve with a wrong or missing PIN gets 403 → fresh PIN approval → `publishing`, new queue job at 0
  - **zero outbound requests** on the full path
  - two simultaneous reconcile submissions: exactly one 200, one 409, one audit entry
- Against the previous `src/publish.ts`, 3 of these tests fail: form rendering, the full path and the concurrency test.
- `npm run check`: 228/228. `npx wrangler deploy --dry-run`: OK.

## Live acceptance after review, merge and deploy (owner does every write)

1. The owner confirms `p_mvppbkvn27705754cc` is absent from Meta Business Suite, in both published and scheduled.
2. The owner opens the post, ticks the box, enters his PIN and clicks **Mark as failed (sends nothing)**. ChatGPT-2 checks `get_post` and expects `failed`.
3. The owner ticks the box, enters his PIN and clicks **Move back to drafts**. ChatGPT-2 checks `get_post`: `draft`, no time.
4. The owner edits and saves in the editor, sets a new time and approves with his PIN.
5. ChatGPT-2 checks `get_post` (`publishing`, then `scheduled` or `published`). After cron has run, ChatGPT-2 checks `list_page_posts` for exactly one matching post.
6. Only then recover the other six, one at a time.

## Prompt for ChatGPT

> You are **ChatGPT-2 | Independent Reviewer** for GSGrimoire/gs-poster. Read `AGENTS.md`, `CLAUDE.md`, the Hub review playbook and `docs/HANDOFF_2026-11-01_CLAUDE_LEGACY_STUCK.md`. Do a **Full review** of the new PR at its exact head. Verify:
> - the diagnosis and root cause (v0.1.0 claim order)
> - that `reconcileStuckPublishing` is one atomic UPDATE with the version fence, age, no Facebook id, no queue job and no active or published Bluesky
> - that nothing backfills `approved_at`
> - that redraft and a fresh PIN approval are still required
> - that `test/legacy-stuck-route.test.ts` uses the bundled `handleWeb` and the outbound recorder
>
> Confirm CI on the exact head. If it passes, merge it alone and watch Deploy and live smoke. Then run the live acceptance steps in the handoff with the owner for `p_mvppbkvn27705754cc` only. Never publish, never use the owner's PIN, never print secrets.
