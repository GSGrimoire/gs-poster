# GS Poster handoff: per-platform editor cards and platform rules registry, 1 November 2026

**Session:** Claude-1 | Implementer. **Branch:** `claude/platform-target-editor`. **Base:** `3f0c0ff` (production).
**Answers:** findings F1 and F3 of ChatGPT-2's 1 November full review (PR #62), the "platform capability registry" step of its architecture section, and Gus's request for a better UI when posting to several platforms with different formats.
**Pull request:** not yet opened (this session's GitHub connector returns 403 on create). Open from `https://github.com/GSGrimoire/gs-poster/pull/new/claude/platform-target-editor` with the text below.
**Independent of** `claude/mcp-update-atomic-63` (#63). Either can merge first; they touch different lines of `src/mcp.ts`.

---

## Review depth and session identities

- **Review depth:** Full review. Editor access is on the Full list. No approval, PIN, publishing, queue, upload or storage code changed.
- **Implementation session:** Claude-1 | Implementer. **Review session:** ChatGPT-2 | Independent Reviewer (requested).
- **Base:** `3f0c0ffd13653d1876bf53dd0c389426ddce913a`.

## What changed for Gus

The saved-draft editor used to stack all captions in one section and all media in another. Now each platform has its own card, side by side on a wide screen (three columns at 1440 px) and stacked on a phone:

- caption, character meter and media for that platform only;
- a format line, e.g. "Up to 4 photos or 1 video · 300 characters · descriptions required · shows best at 1:2 to 2:1";
- live checks that update while typing or ticking Remove: hard limits in red (too many photos, caption too long, description missing, photos and video mixed, TikTok without media), shape notes in amber;
- each photo shows its real shape badge (1:1, 4:5, 9:16, 16:9...), amber where that platform would crop or letterbox it;
- "Copy Facebook caption" on Bluesky and TikTok, asking before it overwrites text (explicit copy, never automatic).

A readiness strip at the top ("Facebook Ready · Bluesky 1 problem · TikTok Ready, 1 note") links to each card. Thumbnails now show the whole picture (`object-fit: contain` on a checkerboard) with a line saying they are not the delivered crop (F1).

Screenshots: `docs/screens/editor-targets-desktop-2026-11-01.png`, `docs/screens/editor-targets-mobile-2026-11-01.png`.

## Code

- **New `src/platforms.ts`:** one entry per platform: caption limits by format, grapheme counting, photo cap, text-only allowed, photo/video mixing, description requirement, display-shape guidance, delivery line. `checkTarget()` is pure. The browser gets the same rules as JSON (`data-rules`) and mirrors `checkTarget()`, so the numbers cannot drift between preview and server.
- Display-shape bounds are guidance only. They never block a save or approval and are not presented as provider acceptance ranges, per the review's warning.
- **Server limits now read the registry:** TikTok 35-photo cap and 2,200/4,000 caption limits in `mcp.ts` (`draft_post`, `update_draft`), the editor's TikTok limit, and the media panel's per-platform caps. Same values as before; no behavior change.
- **`src/draft-editor.ts`:** markup moved into cards. **Every form field name is unchanged**, so `parseEditorForm` and `POST /post/:id/save` behave exactly as before (a test asserts the names and a parse round trip).
- **`src/html.ts`:** light theme gets darker `--warn` and `--ok` for readable contrast on cream.
- Instagram is deliberately not in the registry. Adding it is a new entry plus an adapter, after the owner decisions and media-hosting review in PR #62.

## Tests

`test/platform-targets.test.ts` (6): registry equals the limits the server already enforces; `checkTarget` errors versus notes; one card per platform with checks, media and anchors; unchanged field names and a `parseEditorForm` round trip; rules JSON decodes and the script parses; `targetStates` counts the TikTok shared fallback and caption reuse like the server. `npm run check`: 235 of 235. Wrangler dry-run OK.

Rendered with Playwright at 1500 px (dark and light) and 390 px: no script errors, no horizontal scroll at 390 px, readiness and checks computed from real image dimensions.

## Not in this PR (next steps from the review)

- Per-platform drag-to-reorder and crop/pad variants (F2, issue #33): need the `media_variants` model and server-side rendering.
- One-PIN release for all platforms including TikTok (issue #61, F4).
- The new-draft page (`new-draft-client.ts`) still has its own copy of the limits; move it onto the registry next.
- Live check on the deployed editor with a real draft after merge.
