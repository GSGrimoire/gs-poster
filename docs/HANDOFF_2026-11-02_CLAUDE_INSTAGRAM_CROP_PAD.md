# GS Poster handoff: Instagram crop and pad (preparation only), 2 November 2026

**Session:** Claude-1 | Implementer. **Branch:** `claude/instagram-crop-pad`, built on `claude/platform-target-editor` (merge that first, or review both together).
**Owner decision (Gus, 2 Nov 2026):** build both Instagram options, cropping and padding.
**Pull request:** not opened from this session (connector 403). Open from `https://github.com/GSGrimoire/gs-poster/pull/new/claude/instagram-crop-pad`, base `claude/platform-target-editor` (or `main` after that merges).

---

## Review depth and session identities

- **Review depth:** Full review. New editor storage (`instagram_targets`), a new signed-in media route, private media read through the Cloudflare Images binding.
- **Not touched:** approval, PIN, publishing, queues, uploads, MCP write tools, workflows. **Nothing sends anything to Instagram.** There is no Instagram token, adapter or public media hosting.
- **Implementation:** Claude-1 | Implementer. **Review:** ChatGPT-2 | Independent Reviewer (requested).

## What Gus gets

An Instagram card in the draft editor (turn on the Instagram chip):

- **One frame for the carousel:** Portrait 4:5 (1080 x 1350), Square 1:1 (1080 x 1080) or Landscape 1.91:1 (1080 x 566). All inside Meta's 4:5 to 1.91:1 feed range.
- **Per photo, Crop or Pad:**
  - Crop fills the frame. Drag the preview (or use the arrow keys; Shift for bigger steps) to choose the part to keep. Zoom 1x to 4x with a slider or the + and - keys. A small view of the whole original shows the kept area. "Centre" resets.
  - Pad keeps the whole picture and fills the rest with Dark (brand), Black, White or Parchment (brand).
  - "Crop all" and "Pad all" set every photo at once.
- **Order:** up and down buttons. Remove. Add from any photo already on the post (Facebook, TikTok or Bluesky), or "Add all, in this order". Up to 10.
- **Caption:** own caption with "Copy Facebook caption", 2,200-character meter, live 30-hashtag check.
- **Quality warning:** when a photo would be enlarged ("Enlarged 1.3 times (864 px of the original fill 1080 px). It may look soft."), shown on the photo and in the card's checks.
- **Download:** after saving, each finished photo downloads as a server-rendered JPEG ("Photo 1 · Photo 2 ..."). Gus can post them in the Instagram app today. With unsaved changes, downloads are hidden and the card says "Save to download the finished photos".
- The release rail says Instagram is prepared only and not released.

Screenshots: `docs/screens/instagram-crop-pad-desktop-2026-11-02.png`, `docs/screens/instagram-crop-pad-mobile-2026-11-02.png`.

## Design

- **`src/instagram.ts`:** types, limits from Meta's current Content Publishing reference (JPEG, max 8 MB, 4:5 to 1.91:1, width 320 to 1440, 10 items, 2,200 characters, 30 hashtags, 20 @ tags; checked 2 Nov 2026), strict JSON reader, save rules, and `instagramPlan()`.
- **One geometry function for both sides.** `instagramPlan()` is self-contained; its source text is sent to the browser (`INSTAGRAM_PLAN_JS`). The preview draws with it and the server renders with it. A test asserts identical results.
- **Originals are never changed.** Stored per photo: `url, mode, cx, cy, zoom, bg`. Instagram may only use photos already on the post (`postPhotos`), so the editor's rule still holds: new media only arrives through the private upload routes.
- **Server render, `GET /instagram/:id/:n.jpg`:** behind the existing session and allowlist check. Reads the saved settings, fetches the original through `fetchImage` (same private path as `/media`) and renders with the Images binding:
  - Crop: one transform, trim on four sides in source pixels, then `fit: "cover"` to the exact frame. Cloudflare docs: trim "is performed before resizing and rotation".
  - Pad: `fit: "pad"` with the background colour.
  - Output: JPEG quality 90, `Cache-Control: private, no-store`.
  - 503 if the binding is missing; 404 for an unknown photo.
- **Storage:** new `instagram_targets` table (post_id, caption, frame, items, status). Saved in the same `saveEditorDraft` batch, fenced on `updated_at` and `approved_at IS NULL`. `undefined` leaves it alone, so the MCP `update_draft` path from #63 cannot erase it. `null` removes it. `deletePost` removes it. Read via a `LEFT JOIN` in `POST_SELECT`.
- **Registry:** Instagram entry in `src/platforms.ts` (`framed: true`, so shape is never a note; `maxHashtags: 30`). Order: Facebook, Instagram, Bluesky, TikTok.
- **`get_post`** shows the Instagram settings, marked "Prepared only". No MCP tool can write them yet.
- The per-photo controls are detached from the form (`form="ig-detached"`); only `ig_items` is submitted, and unsaved-change tracking stays correct.

## Tests

`test/instagram.test.ts` (13): crop and pad geometry, clamping and the zoom cap; every frame within Meta's range; browser and server plans identical; strict reader rejects malformed or non-number input; save rules (foreign photo, duplicates, more than 10, 31 hashtags, bad frame, zoom, background); render calls for crop (single trim and cover transform) and pad (fit pad and background) against a recording fake; real D1: save and readback, `undefined` keeps it, stale version and approved post change nothing, `null` and delete remove it; editor form only accepts the post's own photos and allows Instagram-only; render route refuses anonymous requests, 404 for a missing photo, 503 without the binding.

`npm run check`: 248 of 248. Wrangler dry-run OK (gzip 375 KiB).

**Browser check (Playwright, 1500 px light and dark, 390 px):** no script errors; drag and keys change the saved JSON; frame switch, add, and "Pad all" work; no horizontal scroll at 390 px.

**Local render check:** Miniflare's Images stand-in produced JPEGs at exactly 1080 x 1350, 1080 x 1080 and 1080 x 566, with correct pad colours. It does **not** implement `trim` (only resize and rotate), so crop position could not be verified locally.

## Required live acceptance after deploy (before relying on crop)

1. Draft a post with one clearly asymmetric photo (e.g. text in the left third).
2. Turn on Instagram, choose 4:5, Crop, drag the frame fully left, Save.
3. Download Photo 1. It must be 1080 x 1350 and show the left part, matching the editor preview. Repeat with Pad on White: whole picture, white bars.
4. If the crop comes back centred, production ignored `trim`: do not use Crop downloads and report it here.

## Next

- MCP: let Claude set the Instagram target in `draft_post` and `update_draft`, after #63 merges, using the same fenced save.
- Instagram publishing: needs Gus's choice of account and placements (feed carousel first), app permissions, and the leased media-hosting design from PR #62 (S7). The renderer here supplies the exact bytes that hosting would serve.
- Reels and Stories (9:16) are separate placements and not in this PR.
