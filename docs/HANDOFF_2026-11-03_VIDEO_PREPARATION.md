# Full security review: video preparation for TikTok, Bluesky and Instagram

Role: ChatGPT-1 | Implementer (GitHub login: GSGrimoire, shared)
Pull request: #77, base: main after #76
Review depth: **Full**. High-risk triggers: remote GitHub downloads, private R2 copies, integrity readback, database migration and cross-platform video persistence. **Independent review before merge and deployment is mandatory.** Do not mistake implementer tests or self-review for independent approval.

## Scope and non-goals

- TikTok: explicit **Prepare TikTok video privately** on a saved GitHub MP4 already attached in the independent video gallery. Existing PIN-gated inbox send and manual TikTok publication remain unchanged.
- Bluesky: already supports video publication. An explicit button copies Facebook video into the Bluesky draft (requires user-written video description); an optional private preparation action can move an already attached GitHub MP4 to owner-bound R2. Existing PIN-approved Bluesky scheduled publishing remains unchanged.
- Instagram: photo preparation remains supported. Users can choose a saved video from the same post or upload an Instagram-only MP4, then preview and download the **original MP4** for manual Instagram Reel posting. The server does **not** transcode, crop, re-encode, upload or publish to Instagram. Client video metadata may warn about wrong aspect ratio/duration, but cannot independently prove H.264/AAC compatibility.
- Existing **20,000,000 byte** GS Poster video limit remains, even though Bluesky's public platform limit was raised to 300 MB and 10 minutes in August 2026. An expanded file-size/streaming pipeline would be a separate project.

## Privilege and entry-point inventory

- `GET /video/:post/(facebook|bluesky|tiktok|instagram)`: existing signed-in preview with bounded private/GitHub MP4 read, now includes Instagram. No public media URLs.
- `GET /instagram/:post/video.mp4`: signed-in download of only the active saved Instagram target's video, with `Content-Disposition: attachment`, `private, no-store`, media type MP4 and no Instagram API call. A paused or missing target gets 404.
- `POST /post/:post/import-video`: owner session, same origin, antiforgery token, 8 KB JSON cap, draft/rejected only, `approved_at IS NULL`, target enum allowlist, exact optimistic version. The POST body supplies **only** a target and expected version, not a source URL. `src/video-import.ts` selects a saved GitHub URL from the target's server-side data.
- `POST /post/:post/attach-video`: existing guarded route, now accepts `instagram:true` if an active Instagram draft target exists. Existing private-upload ownership and version checks are unchanged. Target edit is guarded against adding video alongside photos and against changes after approval.
- `POST /post/:post/save`: the existing optimistic database transaction stores an Instagram video selector, but accepts only previously attached video references from the same post. It cannot introduce arbitrary media URLs. Switching to a Reel instead of photo carousel is explicit and clears the Instagram photo list only after a browser confirmation; server rejects mixed photo/video saves.
- Existing Model Context Protocol, Facebook cron, Bluesky publish, and TikTok lease/approval endpoints are unchanged. They cannot invoke the new import endpoint.

## Source and storage data flow

1. Authenticate and authorize editor with existing `requireSession`, same-origin, antiforgery and draft/version checks.
2. Select the actual GitHub MP4 source from saved `tiktok_video`, `bluesky_targets.video.url` or `instagram_targets.video`. Require active target and video-only gallery.
3. `fetchVideo` builds GitHub-only raw/API URLs and uses a bounded streaming read up to 20 MB. Only valid MP4 file paths and MP4 `ftyp` magic bytes are accepted. Both public and authenticated requests now set `redirect:"manual"` to avoid forwarding the GitHub read token on cross-origin redirects. Genuine private-repository files requiring redirects may therefore be unsupported; this must be live-tested.
4. Reuse `createUpload` (owner and storage quota reservation), then `handleUploadPut` (single-use bearer token and R2 write). Verify R2 readback byte length and SHA-256 of downloaded bytes **before** marking the upload `stored`. This verifies copied bytes against the downloaded response, not an independent GitHub-original hash.
5. Require `isStoredOwnerVideo` confirmation, then `replacePreparedVideoReference` uses exact original reference and post version, approval, target selection, and no-photo guards. Update only that target's reference; leave all others unchanged.
6. Return success plus updated version. If the activity log fails after persistence, explicitly return an audit warning rather than a misleading failure/retry.

## Failure and recovery states

- No session, foreign origin, bad antiforgery token, malformed target or stale draft: no fetch and no upload grant.
- GitHub unavailable, redirect, invalid MP4 header, oversized streaming response: reject before storage and before any gallery edit.
- Quota or R2 rejection: no gallery edit; bearer upload is never reused after ambiguous write.
- R2 readback differs: never marks the upload ready; best-effort cleanup follows the existing one-use upload rules.
- R2 `stored` is confirmed, but the draft changed before conditional replacement: source reference remains unchanged; privately stored orphan remains until 45-day lifecycle removes it.
- D1 commit acknowledgment ambiguous: return uncertainty, never replay final write automatically; owner reloads and inspects.
- Audit failed after successful replacement: return success with warning and do not retry the successful write.
- A saved Instagram Reel stays downloadable after a separate Facebook/Bluesky approval, but the source expires with existing 45-day private retention if uploaded.
- TikTok and Bluesky publication still require separate signed-in/PIN approval; Instagram cannot publish at all.

## Tests and independent-review focus

`test/video-import.test.ts` uses the production Worker path under Miniflare with isolated GitHub and private R2 mocks. It covers authentication, same origin, bad antiforgery token, forged source URL fields, stale source version, oversized and malformed MP4, no-posting states, one-source-at-a-time cross-platform integrity and isolation, private ownership, Instagram-only uploads, Instagram download authorization, old photo + new video exclusivity, Bluesky alt text, R2 readback mismatch and audit failure after storage. Existing video replacement tests must remain green.

Reviewer: inspect exact final branch head; read `AGENTS.md`, `CLAUDE.md`, `src/web.ts`, `src/db.ts`, `src/upload.ts`, `src/video.ts`, `src/video-import.ts`, `src/draft-editor.ts`, `src/draft-media.ts`, `src/instagram.ts`, `src/tiktok-inbox.ts`, `src/tiktok-media.ts`, `src/bluesky-video.ts` and production schedule/approval callers. Examine session revocation, target owner and status transitions, D1 two-statement batch semantics, leaking token on redirects, same-owner retrieval of uploaded originals, migration of existing D1 database, R2 ambiguous writes, public pull URLs and old publication guards. Test outcomes at the final pinned head are authoritative. Never approve this author's own changes as independent security review.

Not verified: live private GitHub redirects and actual full MP4s, independent upstream-original hashes, Cloudflare production R2, real browser Reel preview/metadata, real TikTok video inbox acceptance or real Bluesky 300 MB uploads (Worker intentionally capped at 20 MB). Production deployment must be verified separately.
