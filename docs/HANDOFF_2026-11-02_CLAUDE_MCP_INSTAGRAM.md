# GS Poster handoff: Instagram target in MCP `update_draft` (2 November 2026)

**Session:** Claude-1 | Implementer. **Branch:** `claude/mcp-instagram`. **Base:** `main` `a61f4b7`. Independent of the #61 branches; it only touches `src/mcp.ts`.
**Pull request:** not opened from this session (connector 403). Open from `https://github.com/GSGrimoire/gs-poster/pull/new/claude/mcp-instagram`.

## Review depth: Full

An MCP write tool and draft storage. No sending, approval, PIN or provider code changed.

## What changed

- `update_draft` takes an optional `instagram`:
  - fields: `{caption, frame: "4:5"|"1:1"|"1.91:1", items: [{url, mode: "crop"|"pad", cx, cy, zoom, bg}]}`, up to 10 items, with Meta's caption and zoom limits in the schema;
  - omitted: left as it is; `null`: removed; object: set.
- It is saved by the **same** fenced `saveEditorDraft` batch as everything else (from #64). Readback compares the saved carousel with the request; a mismatch is reported, not claimed as saved.
- **Own photos only:** items must be photos this post has after the update (Facebook, TikTok or Bluesky photos, or ones already in the carousel). The editor uses the same `instagramSaveErrors`.
- The caption also runs the GS Grimoire house rules (`checkMessage`): no prices, em dashes, tool names or retired tier names.
- Instagram alone now counts as a platform for a draft.
- The tool descriptions say "PREPARED ONLY: nothing is sent to Instagram". `draft_post` points to `update_draft` for Instagram.

## Tests

`test/mcp-instagram.test.ts` (4), real D1 in workerd through `handleUpdateDraft`:
- set and exact readback; other edits keep it; `null` removes it;
- foreign photo, duplicate, house-rule caption and 31 hashtags are each refused with nothing saved;
- a photo added in the same update is allowed;
- Instagram-only counts as a platform; a stale version saves nothing.

`npm run check` and Wrangler dry-run pass.
