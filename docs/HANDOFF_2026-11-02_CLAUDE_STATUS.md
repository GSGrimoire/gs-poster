# GS Poster handoff: status after #64 and #65, 2 November 2026 (14:15 Copenhagen)

**From:** Claude-1 | Implementer. **For:** ChatGPT-1 | Implementer and ChatGPT-2 | Independent Reviewer, and Gus.
**Production:** `main` at `a61f4b7` (merge of #65). Deploy and live smoke test succeeded 2 Nov 07:36 to 07:38 UTC.

## Done and verified

| Item | State | Evidence |
|---|---|---|
| #63 MCP `update_draft` atomic and version-fenced | Merged in #64, deployed, issue closed | **Live acceptance passed 2 Nov 13:12 UTC** (below) |
| Per-platform editor cards and platform rules registry | Merged in #65 (stacked branch) | ChatGPT-2 source review on #65; CI green |
| Instagram feed crop and pad, preparation only | Merged in #65, plus ChatGPT's `03e899b` (downloads hidden when the editor is dirty) | ChatGPT-2 source review: acceptable as editor and manual-download preparation; **not** acceptance of live crop output |

### #63 live acceptance (Claude, through the connected GS Poster MCP, production)

1. `draft_post`: Facebook and Bluesky test draft `p_mvza374cbab57100b7`, `updated_at` `13:12:04.044Z`.
2. `update_draft` with `facebook_enabled:false` and `expected_updated_at:13:12:04.044Z` returned `saved`, new `updated_at` `13:12:08.348Z`, `facebook_enabled:false`.
3. `update_draft` with the **old** `expected_updated_at` and `facebook_enabled:true` was refused: "Not saved: the draft changed since you read it", `current_updated_at` `13:12:08.348Z`.
4. `get_post` confirmed `facebook_enabled:false` and Bluesky unchanged.
5. `delete_draft` removed the test draft. Nothing was approved, scheduled or published; no PIN was used.

The review-page check (Facebook no longer offered) was not done in a browser. `get_post` reads the same `posts.facebook_enabled` that approval reads.

## What ChatGPT (or Gus) still needs to do

1. **Production crop and pad acceptance for Instagram.** This is the only open gate from #65. It needs a signed-in browser, so Gus or a browser-capable session must do it; Claude's cloud session cannot sign in to the editor.
   - Open a draft that has one clearly asymmetric photo (text or a mark in the left third). If none exists, make one with `draft_post` and an image-library URL.
   - Turn on Instagram, add the photo, choose Portrait 4:5, Crop, drag the frame fully to the left, Save.
   - Download Photo 1. Pass: 1080 x 1350 JPEG showing the left part, matching the editor preview.
   - Set Pad, background White, Save, download. Pass: 1080 x 1350 with the whole picture and white bars.
   - Try 1.91:1. Pass: 1080 x 566.
   - **If the crop comes back centred,** production ignored `trim`. Record it on a new issue and do not rely on Crop downloads. Pad does not use `trim`.
   - Record the result (dimensions and a yes/no on position) in a comment or a new issue, then delete the test draft.
2. **Merge this branch** (handoff and refreshed `BACKLOG.md`, docs only, Mini review).
3. **Decide PR #62** (the 1 Nov full review, still a draft). It is the reference for the remaining findings. Suggest: mark it ready and merge as docs.
4. **S3 branch protection** (from #62) is a GitHub settings change for Gus: require a PR and a green CI check on `main`, block direct pushes. Not code; Claude and ChatGPT cannot do it.

## What Claude can build next (no new owner decision needed)

In the order I suggest:

1. **#61 one-PIN release:** one form, one PIN approves Facebook, Bluesky and the TikTok inbox send together, with separate per-platform states, autosave, "Post now" and the server-computed earliest valid time. All already owner-approved in #61. Full review.
2. **Instagram in MCP:** let `draft_post` and `update_draft` set the Instagram target (frame, items, caption) through the same fenced save, so Claude can prepare the carousel. Full review.
3. **#33 per-platform ordering:** drag or up/down ordering for Facebook, Bluesky and TikTok galleries, as Instagram already has.
4. **New-draft page on the registry:** `new-draft-client.ts` still has its own copy of the limits.

## Needs Gus before it can start

- **Instagram publishing:** which Instagram account (Business or Creator, linked to the GS Grimoire Page), first placement (feed carousel suggested), consent to the leased, short-lived media hosting from #62 S7, and Meta app permissions. The crop/pad renderer already produces the exact bytes that hosting would serve.
- **S6:** whether TikTok account connect and disconnect should also require the PIN.
