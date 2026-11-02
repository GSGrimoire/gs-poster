# GS Poster handoff: #33 per-platform photo order, and merge plan for the 2 November branches

**Session:** Claude-1 | Implementer, 2 November 2026 evening.
**This branch:** `claude/33-per-platform-order`, stacked on `claude/61-one-pin-tiktok`, which is stacked on `claude/61-autosave-schedule`.
**Pull requests:** not opened from this session (connector 403). Open each from `https://github.com/GSGrimoire/gs-poster/pull/new/<branch>`, using the branch's handoff file as the PR text.

## Merge plan (ChatGPT-2: one Full review per branch, at its exact head)

| Order | Branch | Base | Handoff | What |
|---|---|---|---|---|
| 1 | `claude/handoff-2026-11-02` | main | `docs/HANDOFF_2026-11-02_CLAUDE_STATUS.md` | Docs only: status, #63 live acceptance, refreshed backlog |
| 2 | `claude/mcp-instagram` | main | `docs/HANDOFF_2026-11-02_CLAUDE_MCP_INSTAGRAM.md` | Claude can prepare the Instagram carousel via `update_draft` |
| 3 | `claude/61-autosave-schedule` | main | `docs/HANDOFF_2026-11-02_CLAUDE_61A_AUTOSAVE_SCHEDULE.md` | Autosave, Post now, earliest valid time, opt-in rollover |
| 4 | `claude/61-one-pin-tiktok` | 3 | `docs/HANDOFF_2026-11-02_CLAUDE_61B_ONE_PIN_TIKTOK.md` | TikTok inbox send inside the same PIN approval |
| 5 | `claude/33-per-platform-order` | 4 | this file | Reorder photos per platform |

Branches 2 and 3 are independent of each other: 2 touches only `src/mcp.ts`, while 3 to 5 touch the editor and the approve route. Merge 3, 4, 5 in order, or review 5 as one stacked diff against main.

## #33: what changed

- In the draft editor, each Facebook, Bluesky and own-gallery TikTok photo (when there are two or more) shows its position and two buttons, "Move Facebook photo 1 earlier" and "... later". They are keyboard-usable, and focus follows the moved photo.
- Each platform's order is separate. A TikTok draft that shares the Facebook gallery follows Facebook's order and has no field of its own, as the editor already explains.
- The form sends `order_fb`, `order_bs`, `order_tt`: the saved positions in the new order, e.g. `2,0,1`.
  - `readOrder` accepts **only an exact rearrangement** of the saved photos (right count, no repeats, in range, digits only). Anything else is refused with nothing saved, so reordering can never add or drop a photo.
  - Remove still works by saved position, applied after ordering.
  - Bluesky descriptions move with their photos.
- Saved through the same autosave and fence as every other edit. An order change reloads the page after saving, because thumbnail addresses are positional.
- Instagram already had its own ordering (#65). Drag-and-drop and the one-page multi-file upload from #33 are not in this branch; the buttons are the accessible base for them.

## Tests

`test/photo-order.test.ts` (5, real bundled `handleWeb`):
- strict order parsing (8 forged forms refused);
- Facebook order with a removal;
- Bluesky order carrying descriptions;
- TikTok own gallery independent of Facebook;
- forged orders save nothing;
- editor markup.

Browser (Playwright, real Worker): pressing Enter twice on "Move Facebook photo 1 later" saved `[1, 2, 0]` and reloaded, with no script errors. `npm run check` and Wrangler dry-run pass on this head.

## Still for Gus

- **Instagram crop acceptance** on the live site (see the status handoff). Still open.
- **After #61 deploys:** one real TikTok-only test approval: carousel arrives in the TikTok inbox, a second click is refused. Delete the test in TikTok.
- **GitHub branch protection** for `main` (review #62, S3).
