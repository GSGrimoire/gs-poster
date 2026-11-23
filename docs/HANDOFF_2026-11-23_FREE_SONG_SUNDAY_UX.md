# GS Poster handoff: Free Song Sunday release friction

**Date:** 23 November 2026, Europe/Copenhagen  
**Role:** ChatGPT-1 | Implementer  
**Review depth for this change:** Mini review. This branch changes only a new-draft preset, a planner shortcut, a noninteractive information notice, a regression assertion and user guidance. It does not touch OAuth, authorization, private media reads/writes, publishing, approval, the database schema or application programming interface contracts.  
**Base source:** main at `90b572402375353ef763174d824c34bebc23eaec`  
**Branch:** `chatgpt/fss-video-first-entrypoint-20261123`  
**Deployment:** Not merged or deployed. No GitHub Actions intentionally run.

## Reproduction from Across the Barricade

The user created a full music video, a YouTube thumbnail and a 20-second social teaser in ChatGPT. The GS Poster tool `import_chatgpt_files` was called twice for original ChatGPT attachments, but each returned `imported_count: 0` and `stopped_reason: Attachment could not be imported or verified. Use secure browser fallback.` No verified `upload://` reference resulted.

Two **unapproved, text-only** GS Poster Facebook + Bluesky drafts for release `Across the Barricade` were saved: `p_mwtqgu5c0316366d98` and `p_mwtqgvcudcbeb16b09`. They were not published. Next, temporary upload pages were requested for the cover, thumbnail and teaser. This unnecessarily multiplied browser steps; the existing signed-in draft page already has `Add video` and `Add photos` components that upload and attach directly.

**Important limitation:** This evidence establishes an end-to-end failure for the native chat adapter in that session. It does not identify whether the cause was ChatGPT host file-parameter injection, a downloadable-origin restriction, expiry, media validation or a network failure. Do not weaken the importer allowlist or accept arbitrary URLs to make it pass.

## Implemented on this branch

- The planner offers **Free Song Sunday video**, which opens `/new?preset=free-song-sunday`.
- The preset selects `video`, preserves the normal Facebook and Bluesky choices, and fills the release grouping without attaching/publishing anything.
- An informational notice separates the short promotional social video from the full YouTube music video and thumbnail.
- The attached test checks the preset, rendered media mode and absence of PIN/publishing controls.
- `CHAT_MEDIA_WORKFLOW.md` and the native-import / batch-upload MCP tool instructions now direct assistants to the existing draft's one-page Add video / Add photos controls **before** generating one-use, per-file upload pages. These tool-description edits do not alter their input schemas, owner checks or handlers.

## Verification status

- Author inspected the full six-file diff against pinned main; changes are limited to UI copy, preset values, guidance and a matching regression test.
- No runtime tests, TypeScript check, Wrangler bundle, browser interaction or live release smoke has been run in this session. The local container cannot resolve GitHub, and the repository dependencies are unavailable. The proposed branch is **not release-ready** until `npm run check` and `npx wrangler deploy --dry-run --outdir dist` pass without consuming unavailable GitHub Actions credits.
- Actual Facebook, Bluesky, TikTok and YouTube publication and media delivery remain untested and unaltered.

## Follow-up priorities, without duplication

1. **Issue #32**, native ChatGPT attachment transfer: investigate the actual host-provided `openai/fileParams` values privately; report bounded failure class without logging bearer addresses; confirm original-file hash and owner-ready status in a real test.
2. **Issue #33** and **pull request #96**, guided editor and platform galleries: preserve one visible per-platform media assignment, independent galleries and useful readiness messages; test mobile.
3. **Pull request #94**, 300 MB private video multipart transport: independent Full review, real Cloudflare Worker streaming and provider acceptance, no auto-merge.
4. **Pull requests #91 and #92**, Free Song Sunday and YouTube: resolve pending metadata/plan review first. Do not claim this UX shortcut implements YouTube publishing.
5. For this actual release, owner may open the saved GS Poster drafts and upload the existing social teaser with Add video. A social video may be attached to Facebook only within Facebook's present 20 MB limit. The 36 MB YouTube video belongs in YouTube Studio, not the Facebook video path.

## Required next step

Run the focused new-draft test and full check from a connected development environment, inspect the rendered planner and form on desktop and mobile, then a separate integrator can evaluate this Mini-review branch under the existing GS Poster deployment rules. Do not merge or deploy from the implementation session.