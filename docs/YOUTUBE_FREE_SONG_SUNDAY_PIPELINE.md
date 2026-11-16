# YouTube / Free Song Sunday: manual-assist first, automated upload gated

**Status (16 November 2026): Proposed plan for independent review and Gus's explicit approval. Documentation only. No YouTube target is live, no credentials are configured by this change, and no uploader or production deployment is authorized.**

**Parent:** foundation pull request #91, `feature/youtube-free-song-sunday-foundation-20261115`. This plan revision is in a separate, documentation-only pull request stacked on that branch because this file does not yet exist on `main`. Do not merge or deploy either pull request based only on this document.

**Asana scope:** https://app.asana.com/1/1199525921817881/project/1219262183442034/task/1220546143063489

## Objective and existing work

The initial case is a finished landscape MP4 music video for a Free Song Sunday release, associated with a relevant free/public Patreon post. GS Poster prepares accurate, validated YouTube-facing metadata and hands it to Gus, who uploads and publishes the video in YouTube Studio. It is not a YouTube Shorts converter.

- The foundation `src/youtube-metadata.ts` currently exists only on pull request #91. It is a pure validator and private-only metadata-body builder, imported by its test, not by live publication routes. This document does not authorize integrating it before its correction and review.
- GS Reels has a **separate, unmerged** `claude/youtube-music-video` branch with an FFmpeg music-video renderer, `tools/youtube_upload.py`, and `.github/workflows/youtube.yml`. Its existing uploader uses GitHub Actions secrets and can initiate `videos.insert` and `playlistItems.insert`. It is not the approved production uploader.
- The GS Reels script records `uploaded.json` only after obtaining a video identifier. It does not durably save a resumable session before the final upload request. An ambiguous final response therefore requires redesign before reusing that uploader; simply retrying a plan could create a duplicate.
- GS Poster currently accepts MP4 uploads only up to 20 MB. Do not silently increase that limit or put full-length private media in the public GS Poster repository.
- Keep video rendering in the existing GS Reels workflow or another explicitly approved renderer. A Cloudflare Worker is not the full-length video encoder.

## Phase 1: owner-operated manual-assist, without Google login

**Decision:** This is the first implementation phase. GS Poster neither authorizes with Google nor sends a video or metadata to YouTube. Opening YouTube Studio is a browser navigation initiated by Gus, not a server-side upload.

### Draft data and review

1. Add a separate **YouTube target per GS Poster draft**. Store its own title, description, tags, reviewed Patreon post URL, audience decision (`madeForKids`), rights confirmation, synthetic-media declaration, and optional playlist identifier. Do not overwrite Facebook, TikTok, Instagram or Bluesky captions with YouTube text.
2. Validate the exact saved target with the reviewed `validateYouTubeMusicVideoDraft` contract: character and byte limits, house rules, canonical Patreon link, URL presence in description, explicit audience and rights, and disclosure warnings. A canonical `/posts/` URL does **not** establish that the Patreon post is free or public; Gus must confirm availability during review.
3. Preserve the existing owner-only GitHub session, same-origin checks, cross-site request forgery protection, version fencing and safe draft-save semantics. Persist the reviewed target with the draft, not in an ephemeral browser-only form. Display warnings separately from blocking validation errors.
4. Show a readable target preview and **Copy title**, **Copy description**, **Copy tags**, **Copy Patreon link**, and an optional **Copy all checklist**. Copying never calls YouTube. Do not claim that copying submitted, scheduled or uploaded anything.
5. Show an **Open YouTube Studio upload** control, with the verified official Studio upload destination. Match the existing `src/x-share.ts` **Open in X** interaction pattern: the owner-initiated open is logged once in GS Poster and the primary button becomes greyed out after it is pressed. Preserve a clearly labeled **Reopen YouTube Studio** fallback. Record the first click and later reopens without confusing `opened` with `uploaded`, `private`, `scheduled` or `public`.
6. The click log is an internal, non-publishing GS Poster write protected by owner session, same-origin and cross-site request forgery checks; it is not a proxy to Google. Use the same no-personal-identification-number approach as **Open in X** for this non-publishing click, while preserving existing approval rules for all other targets.
7. Gus chooses the account and channel in YouTube Studio, attaches the MP4, verifies metadata, audience, rights, disclosure, thumbnail and playlist, then uploads and publishes or schedules there. GS Poster never infers success from an open button. Do not mark the draft posted without an explicit owner-confirmed outcome, if that capability is subsequently designed.

**Phase 1 exclusions:** no Google Open Authorization (OAuth), consent screen, refresh token, YouTube application programming interface calls, server upload, video transfer, new model calls, playlist mutation, thumbnail mutation, publish scheduling or automatic external side effect. No new production privileges. No Model Context Protocol tool may upload.

**Phase 1 acceptance:** persisted/reopened draft target matches the reviewed version; disabled and warning states are accurate; invalid fields fail safely; copy values are exact; Open/Reopen logs and greying survive reload without misreporting upload; desktop/mobile and owner/unauthorized route tests pass; `npm run check` and Worker dry-run pass. This phase gets its own reviewed integration pull request after Gus approves this plan.

## Phase 2: optional automated upload, blocked until decisions are written and approved

**Default is not to implement this phase.** No uploader code, new secrets or integration migrations before every gate below is resolved, a separate Full security review is commissioned and Gus explicitly authorizes implementation.

### Gate A: exactly one authoritative uploader

- Reconcile the existing unmerged GS Reels `claude/youtube-music-video` work first: its GitHub Actions upload workflow, refresh-token storage, private-video metadata, resumable retries, checkpoint persistence and playlist insertion.
- Document a single decision: **GS Poster Worker** owns the upload, or **GS Reels** owns it. Only one path may call `videos.insert`. If migrating to GS Poster, disable or retire GS Reels upload triggers before first use; if retaining GS Reels, GS Poster must not add another uploader. Rendering can remain separate.
- The current GS Reels uploader's GitHub Actions secret design conflicts with a strict requirement that the refresh token exist **only in a Worker secret**. Reusing it unchanged is not compatible. Resolve the uploader choice and secret-location requirement together; do not quietly copy the token between systems.
- Specify immutable input version, accepted MP4 source, owner identity, verified digest and accountable job ID at the boundary between renderer and uploader.

### Gate B: Google authorization and token lifecycle

- Verify the actual Google Cloud project, its OAuth consent screen user type, publishing status, requested YouTube scope, channel and quota. **These account settings have not been inspected.**
- Google's general OAuth documentation says refresh tokens issued to **External / Testing** apps expire after **seven days** when YouTube upload scope is requested. A weekly cadence is unreliable at that boundary. Choose and document either: switch to **In production** (potentially unverified, owner-only, subject to actual scope/consent/verification requirements and limits), or explicitly accept reauthorizing at least weekly. Do not assume that merely pressing In production guarantees a permanent token.
- For the GS Poster Worker option, the refresh token and any client secret are Cloudflare Worker secrets only, never D1 data, source code, responses, logs, or issue comments. If GS Reels remains the uploader, its existing Actions-secret design requires a separately approved security exception or redesign before proceeding. Refresh token rotation/revocation and failed refresh must fail closed.
- Use a separate Google project/client for staging and production, bounded permissions and no live owner token during development.

### Gate C: visibility policy, updated on 16 November 2026

**Corrected platform fact:** YouTube's **2 November 2026** Data API revision reversed the 2020 rule automatically locking uploads from unverified application projects to private visibility. Do **not** state or rely on that old audit lock. Reference: https://developers.google.com/youtube/data/revision_history and https://developers.google.com/youtube/data/reference/rest/v3/videos .

**GS Poster safety choice:** any future automated upload, if approved, must explicitly request `privacyStatus: "private"`; omit no visibility field, and never schedule, publish or change visibility automatically. Gus makes final publication decisions in Studio. This is an owner policy, not an externally imposed unverified-project restriction.

**Unresolved compliance gate:** YouTube's Required Minimum Functionality and developer policies say an application uploading videos must let its user choose public, private or unlisted visibility. A hardcoded private-only uploader may conflict with that requirement even when followed by manual Studio publication. Before implementing an application uploader, obtain a reviewed compliant user-flow design or remain with Phase 1 manual uploading. Do not build a public/unlisted chooser or any live uploader without new explicit Gus approval; do not assume a YouTube audit is the prerequisite for this choice. References:
- https://developers.google.com/youtube/terms/required-minimum-functionality
- https://developers.google.com/youtube/terms/developer-policies/

### Gate D: large private media and integrity

- If GS Poster owns the upload, design a separate size-checked and digest-checked full-length MP4 intake path. The existing 20 MB limit stays unchanged until such a path is reviewed. Bound file size, chunk count, intake time, allowed content type, verified MP4 structure, storage budget and retry policy.
- Stage only owner-authorized media in private R2 with restrictive object keys, expiring upload capability, server verification of declared versus actual size and cryptographic digest, no publicly reusable media link, and cleanup that does not destroy unresolved evidence.
- If the uploader remains inside GS Reels, document the equivalent secure render-to-upload trust and digest boundary rather than creating a second GS Poster transfer service unnecessarily.

### Gate E: thumbnail is a separate decision

- **Preferred first option:** Gus sets the thumbnail in YouTube Studio.
- Optional later option: `thumbnails.set` runs as its own authorized, checkpointed step, only after a verified video ID exists. It must not start a new video upload on failure. Confirm the channel has the required phone-verified thumbnail capability and appropriate API permissions. References: https://developers.google.com/youtube/data/reference/rest/v3/thumbnails/set and https://support.google.com/youtube/answer/9722880 .

### Gate F: exact approval, durable upload and reconciliation

1. Reuse GS Poster's authenticated owner session, personal identification number (PIN), lockout, anti-forgery checks, version fencing and atomically claimed approval. An upload job must reference the **exact immutable saved target version and verified media digest** approved by Gus. Later edits require a new approval.
2. `videos.insert` initiation must be a one-way, idempotency-fenced transition. Save the resumable session URI and initiation state durably **before the final media request**. Treat that URI as sensitive capability material, access-controlled, never logged or exposed to Model Context Protocol tools. If initiation itself is ambiguous and no session was saved, stop for reconciliation rather than initiating another upload.
3. Resume only the previously persisted session after inspecting its known state; persist offsets and confirmed transitions. Any timeout, lost final response or unclear completion becomes **needs reconciliation**. Never start a fresh `videos.insert` automatically and never infer upload failure solely from a timeout.
4. On confirmed successful upload, record the immutable YouTube video identifier and private status as a separate checkpoint. Processing, private upload and public publication are different states. Manual reconciliation needs signed-in owner confirmation and the PIN; an unknown response must not be treated as safe-to-retry.
5. Add to the approved Free Song Sunday playlist only as a **separate one-time** side effect, after video ID confirmation. Check existing playlist membership or a completed insertion record before attempting. Ambiguous playlist response requires reconciliation, not blind duplicate insertion. Playlist or thumbnail failure never triggers another video upload.
6. No Model Context Protocol tool, draft-creation action, timer or assistant call can initiate, resume or publish a video. No automatic public/unlisted transition. Log only sanitized state, identifiers appropriate to owner-private storage and error categories, never tokens, session URIs, video bytes or user text in general diagnostics.
7. Model the full failure path: `draft` → `approved` → `upload initiating` → `session saved` → `transferring` → `private upload confirmed` → `playlist pending` → `complete`, with `needs reconciliation`, `failed before initiation` and owner-authorized abort as explicit separate branches. Do not let a restart or concurrent worker bypass a checkpoint.

### Gate G: isolated staging before any live token

- Establish a separate staging Worker, private R2 bucket, D1 database, Google OAuth client/project and test YouTube channel for the GS Poster Worker design. If GS Reels is selected, document an equally isolated staging Actions runner/storage path rather than coupling it to live credentials.
- Use synthetic fixtures for initiation, session creation, partial transfer, expiry, 308 resume, ambiguous final success, duplicate prevention, playlist one-time insertion, failed token refresh, owner rejection and stale-version approval. Then perform a **separately authorized** test-channel upload without real owner media.
- Confirm scope/permissions, quota and expiry, confidential secret storage, owner revocation, size and digest handling, independent Full review of the whole affected security path, green checks and explicit Gus authorization before any live token or deployment.

## Decisions outstanding

1. Gus approves or rejects **Phase 1 manual-assist** and its exact draft fields and Open/Reopen logging.
2. The GS Reels uploader must be reconciled and one owner chosen before Phase 2.
3. Verify the actual OAuth consent screen state and decide production versus weekly reauthorization.
4. Decide how to satisfy YouTube's application upload visibility-choice rule while preserving GS Poster's private-first operating policy. If unresolved, remain manual-assist.
5. Choose large-file intake if the Worker hosts uploads, thumbnail workflow and test environment only if Phase 2 receives separate authorization.

**Review and release:** This is a documentation-only plan. It must receive independent review in its own pull request and Gus's approval before any Phase 1 integration code. A separate Full review and further explicit approval precede any Phase 2 uploader. Do not merge an unreviewed change; merging GS Poster's `main` triggers production deployment.

## Documentation consulted

- Google OAuth refresh tokens: https://developers.google.com/identity/protocols/oauth2
- OAuth app statuses and unverified use: https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
- YouTube API revisions (2 November 2026): https://developers.google.com/youtube/data/revision_history
- YouTube upload method: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- Required Minimum Functionality: https://developers.google.com/youtube/terms/required-minimum-functionality
- Developer policies: https://developers.google.com/youtube/terms/developer-policies/
- Resumable upload: https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
- Playlist insertion: https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/insert
- Custom thumbnails: https://developers.google.com/youtube/data/reference/rest/v3/thumbnails/set
- Channel verification: https://support.google.com/youtube/answer/9722880
