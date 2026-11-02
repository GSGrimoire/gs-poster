# GS Poster handoff to ChatGPT: review queue, 2 November 2026 (16:30 Copenhagen)

**From:** Claude-1 | Implementer. **To:** ChatGPT-1 | Implementer (open PRs) and ChatGPT-2 | Independent Reviewer (review and merge).
**Production:** `main` at `a61f4b7`, deployed and smoke-tested 2 Nov 07:38 UTC. Nothing below is merged or deployed.

Claude's session cannot open PRs or comment on GitHub (connector returns 403), so each branch carries its PR text in a handoff file. Please open the PRs from the branches. No CI has run on them yet, because CI starts with the PR. **Review at the exact head**, and let CI run on each PR before merging.

## The queue, in merge order

| # | Branch @ head | Base for the PR | Review | PR text (on the branch) |
|---|---|---|---|---|
| 1 | `claude/handoff-2026-11-02` @ this commit | `main` | Mini (docs only) | `docs/HANDOFF_2026-11-02_CLAUDE_STATUS.md` and this file |
| 2 | `claude/mcp-instagram` @ `71fa794` | `main` | Full | `docs/HANDOFF_2026-11-02_CLAUDE_MCP_INSTAGRAM.md` |
| 3 | `claude/61-autosave-schedule` @ `52d6ddd` | `main` | Full | `docs/HANDOFF_2026-11-02_CLAUDE_61A_AUTOSAVE_SCHEDULE.md` |
| 4 | `claude/61-one-pin-tiktok` @ `d7b03c8` | `claude/61-autosave-schedule` | Full | `docs/HANDOFF_2026-11-02_CLAUDE_61B_ONE_PIN_TIKTOK.md` |
| 5 | `claude/33-per-platform-order` @ `a7d0a04` | `claude/61-one-pin-tiktok` | Full | `docs/HANDOFF_2026-11-02_CLAUDE_33_ORDER_AND_MERGE_PLAN.md` |

- 2 is independent (only `src/mcp.ts`, tests, docs) and can merge in any order relative to 3 to 5.
- 3, 4 and 5 are stacked. After 3 merges, retarget 4's PR to `main`; after 4, retarget 5.
- If you prefer, review 5 as one diff against `main` (it contains 3 and 4), then merge 3, 4, 5 in sequence.
- Each merge to `main` deploys. Merging 3 alone is safe: autosave and scheduling work without the TikTok change.

Local results at each head: `npm run check` all pass (262 on 2, 269 on 3, 279 on 4, 284 on 5) and `npx wrangler deploy --dry-run --outdir dist` OK.

## What each branch does, and where to look hardest

**2. Instagram in MCP `update_draft`.**
- Optional `instagram` (caption, frame, up to 10 items with crop/pad settings). Omitted leaves it; `null` removes it.
- Saved by the same fenced `saveEditorDraft` batch as #64, with readback.
- **Check:** the own-photos rule in `handleUpdateDraft` (photos the post has after this update, including Bluesky and the existing carousel); house rules on the caption; that nothing sends to Instagram.

**3. #61 part A: autosave, Post now, earliest valid time, opt-in rollover.**
- `POST /post/:id/save` answers JSON when `X-GS-Autosave: 1`. Same session, same-origin, CSRF, version fence, draft-only.
- New `src/schedule.ts` (`minLeadFor`, `earliestValidTime`, `decideReleaseTime`); **lead times unchanged** (30 min Facebook photos, 12 otherwise).
- Rollover is opt-in per approval. The moved time is written by the same `claimForPublish` batch and audited `schedule-rolled-over`. Post now (null) is never turned into a schedule.
- **Check:**
  - `decideReleaseTime` boundaries;
  - the approve route uses `decision.when` everywhere after the decision;
  - the client autosave serialises saves, never sends while the uploader is attaching (`window.gsMediaBusy`), stops on 409 and keeps edits, and reloads only after structural changes (`p_`, `remove_`, `order_`, `when`), so the server-rendered release panel always lists exactly the saved targets;
  - `GET /earliest-time` is signed-in and read-only.
- Note: autosave turns a **rejected** post back into a draft on the first edit, as manual Save always did; the note is kept.

**4. #61 part B: TikTok in the same PIN approval.**
- New `src/tiktok-release.ts`. The release form shows TikTok above the PIN, with consent required and a conspicuous "sent to your inbox the moment you approve" note. One "Approve selected targets".
- Server order: all existing gates, then `tiktokReleasePlan` refusals (not connected, no `video.upload`, existing transfer, invalid media, limits), then **all** Facebook/Bluesky pre-checks, then one TikTok send via the **existing** exactly-once functions fenced on the same version, then the unchanged `approveAndPublish`.
- Separate per-platform outcomes; nothing retried. Direct Post never chosen. The old TikTok options step is hidden for drafts only.
- **Check:**
  - the TikTok send happens only after every Facebook/Bluesky check;
  - the transfer does not change `posts.updated_at` (so the claim still matches);
  - an exception in `approveAndPublish` after a TikTok send is reported as a separate Facebook outcome, not lost;
  - TikTok-only keeps the post a draft;
  - TikTok caption, media and title come only from the saved draft, never from the form.

**5. #33 per-platform photo order.**
- Move earlier/later buttons per Facebook, Bluesky and own-gallery TikTok photo; `order_fb`, `order_bs`, `order_tt`.
- **Check:** `readOrder` accepts only an exact rearrangement of the saved photos (no add, repeat or drop); removal by saved position; Bluesky descriptions follow their photos; the shared TikTok gallery has no order of its own.

Each handoff lists its test matrix. All route tests run the real bundled `handleWeb` in workerd. Branch 4 uses an outbound recorder that plays TikTok's API and refuses everything else, asserting zero Facebook calls.

## Live acceptance still open (needs Gus in a signed-in browser)

1. **Instagram crop (from #65, already live):** asymmetric photo, 4:5, Crop dragged fully left, Save, download Photo 1. Expect 1080 x 1350 showing the left part. Then Pad on White: whole picture with white bars. If the crop comes back centred, production ignored `trim`: open an issue and do not rely on Crop.
2. **After 3 deploys:** edit a test draft, watch it say Saved, reload and confirm the edit. Use Earliest valid time on a photo draft; it should be at least 40 minutes ahead.
3. **After 4 deploys:** one TikTok-only test draft with two photos, Approve once. Check it arrives in the TikTok inbox, a second click says "Already sent to TikTok", then delete it in TikTok.

## Other open items

- PR #62 (1 Nov full review) is still a draft; suggest merging it as docs. S3 (branch protection on `main`) is a GitHub setting for Gus. S4 (OAuth consent origin/CSRF), S5 (GitHub fetch redirect policy) and S6 (PIN for TikTok account settings, an owner decision) are not started; consider filing them as issues.
- Old review PRs #54 and #55 look superseded; close them if you agree.
- Issue #61 can close when 3 and 4 are merged and live acceptance item 3 passes. Issue #33 stays open for drag-and-drop and one-page multi-file upload.

## Rules unchanged

Claude does not merge or deploy. No secrets in diffs. Never publish real posts in review; use the recorders. Approval, PIN, lockout, CSRF, same-origin, the allowlist and `claimForPublish` must be unchanged or stronger.
