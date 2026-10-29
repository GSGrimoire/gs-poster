# ChatGPT-to-GS Poster content intake: architecture, supported types and backlog

**Updated:** 29 October 2026  
**Status:** Implemented in the branch accompanying this document: batch private upload links, batch readiness inspection, and TikTok-specific caption storage. A true native binary attachment handoff remains **dependent on the ChatGPT client/runtime** and is not claimed as implemented.

## Goal and trust boundary

The desired editorial flow is: create an asset in ChatGPT or Claude, transfer its **original bytes** into GS Poster's private Cloudflare R2 storage, create an **unapproved** GS Poster draft, and review or publish separately in the GS Poster browser using the existing authenticated GitHub session and approval PIN.

Neither a model's ability to see an image nor an MCP text tool's ability to receive a URL proves the model can obtain the underlying media bytes. **Never promise an automatic direct transfer without the client-provided byte-access and outbound request capability.**

## Available input paths, ordered by preference

1. **Existing owner-controlled GitHub files:** `draft_post` accepts supported GitHub image or MP4 links. This is optional and not required for fresh media.
2. **Assistant can access original file bytes and PUT them:** `request_upload` or `request_uploads` generates one-time upload URLs. A byte-capable execution environment uploads actual bytes and checks `check_upload` / `check_uploads` afterwards.
3. **Assistant has no bytes or cannot PUT:** `request_upload` or `request_uploads` returns short-lived `upload_page_url` values. User selects each file on the private browser handoff. The assistant verifies with `check_uploads`, then drafts. No GitHub staging or command line.
4. **Future native attachment connector:** Investigate actual client-supported attachment/binary resource handles and authenticated upload continuation. Do not expose broad public fetch, arbitrary remote URLs, cookies or unbounded base64 blobs as a substitute.

Batch input is in **intended carousel order**. Each upload grant expires after 10 minutes; for large galleries the user may need to request fresh batches. Storage retains the existing 45-day lifecycle and enforces 10 MiB per image, 20,000,000 bytes per MP4, per-hour link quota and overall storage budget.

## Content types already represented in GS Poster

| Content | Current draft representation | Notes and limits |
|---|---|---|
| Text or promotional descriptions | `message`; independent `bluesky.caption`; optional `tiktok_caption` | House rules applied to common captions; redact sensitive data |
| Hashtags | Literal hashtags in captions | No standalone hashtag database or automatic cross-platform rewriting |
| Links | `link` for Facebook link previews; `bluesky.patreon` free Patreon card | TikTok links in caption may not be tappable; do not promise clickthrough |
| Images / carousels | Ordered `images` references, independent `bluesky.images` with alt text | Facebook up to 80; TikTok up to 35; Bluesky up to 4 |
| Video / reel | `video` as MP4 upload reference; `bluesky.video` where selected | 20 MB initial private upload limit; no automatic audio mixing/transcoding, editing or subtitles |
| Post metadata | `label`, `release`, `publish_at` | TikTok time is only a planning slot; not automatic publishing |
| TikTok review | `tiktok_enabled` plus `tiktok_caption` | Inbox or explicit private direct test requires separate PIN in website |
| Reddit communities | **Backlog**, no connected account | Requires API approval and subreddit-specific rules |
| Facebook Groups | **Backlog**, manual-dispatch only | Retired public Groups API |

When selecting multiple platforms, the current model shares the main image gallery between Facebook and TikTok; Bluesky can use its own four images and alt text. Different Facebook and TikTok galleries for the same post need a future `platform_media_targets` model.

## Recommended chat workflow

Example verbal request to ChatGPT:

> Create a GS Poster draft from these attached images, in the order I gave them, for TikTok and Bluesky. Use the full carousel for TikTok and pick the best four for Bluesky, with accurate alternative text. Use different captions and appropriate hashtags. Transfer actual file bytes if possible; otherwise give me the secure upload pages. Verify storage before creating the draft. Do not publish anything.

1. Inspect attached media and clarify actual filenames where necessary. If the chat has no bytes, state this and use the browser handoff.
2. Call `request_uploads({filenames:[...]})` for up to 35 files. Preserve intended order. Handle partial successes and expired links explicitly.
3. Transfer using actual binary PUT or user-selected private handoff.
4. Call `check_uploads({references:[...]})`; proceed only with `all_ready:true` or tell the user exactly which uploads remain missing.
5. Call `draft_post` with platform selection, ordered media references, platform-specific captions, links, hashtags contained in captions, labels, release metadata and intended planner date.
6. Return the draft review URL and post ID. Never say `published` after draft or upload success. Existing owner PIN remains the only publishing authority.

## Input contract and compatibility matrix

- Facebook + TikTok can share the main ordered gallery. If TikTok selected, enforce maximum 35 main images.
- Bluesky images are independent `{url,alt}` objects, limited to four. Do not infer alt descriptions from filename alone.
- TikTok-specific `tiktok_caption` uses 4,000-character photo and 2,200-character video limits; otherwise the TikTok review page defaults to shared `message`. Facebook `message` and Bluesky caption are distinct.
- Facebook link preview is used only when no Facebook images; other links may be plain text.
- TikTok video and photo carousels require different TikTok API flows, both already guarded by separate human PIN confirmation. Do not create automatic TikTok cron scheduling as a side effect of draft creation.
- Limit stored private media to accepted JPG, JPEG, PNG, GIF and MP4. Animated GIF semantics may not survive photo conversion; animated-content handling needs a separate plan.
- If chat supplies a user-created video with background music, accept the final MP4 as is; GS Poster does not modify, license, synchronize or mix tracks.

## Future work in descending priority

1. **Native chat byte handoff:** Determine if ChatGPT connector tools can reference uploaded/generated files as opaque file resources or upload streams. If available, add a dedicated authenticated media-ingest tool without requiring public URLs or text-base64 transport. This may need connector/app-host support rather than a plain MCP text tool.
2. **Batch handoff usability:** One drag-and-drop multi-upload screen that can consume an authenticated upload session for up to 35 media objects, show progress and image order, and return a single collection reference. Current `request_uploads` returns separate one-time pages.
3. **Platform-targeted galleries:** Make Facebook and TikTok image order/selection independent in one draft while Bluesky retains separate alt text. Model shared assets once and map references to destinations to avoid duplicate storage.
4. **Larger video production:** Streaming or multipart upload, server-side media probing, optional thumbnails, subtitles, audio asset handling, aspect-ratio warnings and per-platform video limits. Current 20 MB cap is intentionally conservative.
5. **More presentation metadata:** First-class hashtags and link-attribution fields, platform caption previews, image crop/cover selection, TikTok sound rights declarations, accessible alternative text, and per-platform permitted format validation.
6. **New destinations:** Reddit subreddit draft/approved publishing once API access is granted; manual Facebook Group handoff, not retired Group API calls.

## Security requirements for later sessions

- Maintain the existing approved-only Facebook/Bluesky queues, GitHub login allowlist, approval PIN lockout, same-origin and CSRF checks, audit log and claimForPublish semantics.
- The chat connector must remain **draft-only**, including new target types. It must not expose direct publishing actions.
- Never accept arbitrary external URL fetching from untrusted chat values; use existing GitHub URL restrictions or dedicated authorized upload references.
- No token, upload bearer URL, user PIN, authorization cookie or secret belongs in a GitHub commit or in public logs.
- Use an immutable claim and human reconciliation for ambiguous third-party posting outcomes; do not blindly retry.
- Tests should exercise cross-platform media count, upload ownership, expiry, carousel order, TikTok caption limits and no-publish guarantees.

## Related findings

- [Reddit feasibility](./REDDIT_PUBLISHING_RESEARCH_2026-10-29.md)
- [Facebook Groups limitations](./FACEBOOK_GROUPS_RESEARCH_2026-10-29.md)
- [Existing browser handoff workflow](../CHAT_MEDIA_WORKFLOW.md)

This is an implementation plan, not evidence that every ChatGPT or Claude configuration exposes native attachment bytes to a custom connector.
