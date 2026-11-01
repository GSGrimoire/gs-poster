# GS Poster handoff: atomic, version-fenced MCP `update_draft`, 1 November 2026

**Session:** Claude-1 | Implementer. **Branch:** `claude/mcp-update-atomic-63`. **Base:** `3f0c0ff` (production, merge of #60).
**Answers:** issue #63, findings S1 and S2 of ChatGPT-2's 1 November full review (PR #62).
**Pull request:** not yet opened. This session's GitHub connector returned 403 on "create pull request". Open it from
`https://github.com/GSGrimoire/gs-poster/pull/new/claude/mcp-update-atomic-63` and use the text below as the body.

---

Fixes #63.

## Review depth and session identities

- **Review depth:** Full review (MCP tool persistence, draft integrity, concurrency, uncertain commits).
- **Implementation session:** Claude-1 | Implementer
- **Review session:** ChatGPT-2 | Independent Reviewer (requested)
- **Base:** `3f0c0ffd13653d1876bf53dd0c389426ddce913a`. Head: the branch tip when the PR is opened.

## What changed

- `handleUpdateDraft` (`src/mcp.ts`) now saves through `saveEditorDraft` (`src/db.ts`), the single D1 batch the browser editor already uses. `posts` and `bluesky_targets` change in one transaction fenced on `updated_at`, `approved_at IS NULL` and status draft/rejected.
- `facebook_enabled` is written to `posts`, the field approval reads (S1).
- New optional `expected_updated_at`. A mismatch saves nothing and returns `current_updated_at`. Optional so existing connector clients keep working; when omitted the version read at the start of the call is the fence. Replies now return `updated_at`.
- `saveEditorDraft` gained an optional `link`. `undefined` keeps the stored link, so the browser path is unchanged.
- `handleUpdateDraft` checks `isCurrentEditor` itself and refuses an approved post up front (and again in SQL).
- Failures: fence miss reports "not saved" with the current status; a thrown batch reads back and reports "uncertain" if `updated_at` moved, otherwise "not saved". Never retried. After saving, readback compares `facebook_enabled`, Bluesky presence and message with the request. An audit insert failure becomes `audit_warning` instead of hiding a completed save.
- Difference: the old MCP path cleared `note` on a plain draft. It now leaves it, like the browser editor.
- No PIN, approval, queue, provider or workflow code touched.

## Tests

`test/mcp-update-atomic.test.ts`, 10 tests on real D1 in workerd (Miniflare) through the production handler: Facebook off and on; stale version; two editors on one version (exactly one wins); approved post refused; approval racing the save; failing statement rolls back both rows; commit with lost response reported as uncertain; Bluesky removal keeps Facebook and the last platform cannot be removed; TikTok `null` fallback preserved; omitted fence still fences.

Tests 1 to 7 fail on the old source and pass on this branch. `npm run check`: 239 of 239. `npx wrangler deploy --dry-run --outdir dist`: OK. No publish call, Facebook request or PIN in any test.

## Remaining

- The revision is the `updated_at` timestamp (monotonic per save), as elsewhere in the repo. An integer revision belongs in the platform-targets migration (review phase 2).
- Live acceptance after deploy: `update_draft` with `facebook_enabled:false` on a throwaway draft, confirm the review page no longer offers Facebook, delete the draft.
- Needs an independent Full review at the exact head. Merging deploys. Claude does not merge.
