# YouTube / Free Song Sunday integration

**State:** foundation only; no YouTube target is active, no credentials are configured, no video is uploaded, and no production deployment is authorized by this branch.

**Plan status:** revised 16 November 2026 after an independent full review (Claude) of the plan, this branch and the existing GS Reels uploader. The platform facts below were checked against Google's own pages on that date. Sections marked **Owner decision** are open and block Phase 2.

**Asana scope:** https://app.asana.com/1/1199525921817881/project/1219262183442034/task/1220546143063489

## Decision and existing assets

The first use case is an existing, finished MP4 music video: tabletop roleplaying ambience, usually one illustration with minimal animation, referring viewers to a relevant recent Patreon product. This is a regular landscape YouTube video, not a Shorts conversion.

GS Reels already has a renderer and a private YouTube uploader on the **unmerged** `claude/youtube-music-video` branch of the private `GSGrimoire/gs-reels` repository (commit `6d67321`, 25 October 2026: `tools/youtube_upload.py`, `.github/workflows/youtube.yml`). On a push of `youtube/<slug>/video.json` to the default branch it renders with FFmpeg in GitHub Actions, uploads as private with a resumable upload, adds the video to the playlist in `youtube/config.json` and commits an `uploaded.json` record. It holds the rendered file where it is made, so it has no file-size problem.

**There must be exactly one uploader, and it should be that one.** GS Poster must not grow a second upload pathway. See "Division of work" and the defects listed under "GS Reels uploader: required fixes" below.

Cloudflare Workers are well suited to coordination, approval, private storage and upload bookkeeping, not full-length audiovisual encoding. The current GS Poster video intake limit is 20 MB. Plan a separate, integrity-checked large-file route before accepting full-length music videos. Cloudflare Stream can transcode existing videos but is not the music-plus-image compositor for this use case.

## Target pipeline

1. **Source:** owner supplies the completed MP4, or GS Reels renders it from approved audio and artwork. Record provenance, copyright and usage rights; do not persist source media in the public GS Poster GitHub repository.
2. **Private intake:** transfer the verified original into private object storage (or securely refer to a vetted GS Reels output), record size and digest, require owner scoping, and never expose unrestricted public media URLs.
3. **Draft:** prepare per-target YouTube title, description, link to the free Patreon post, optional playlist, tags, audience selection, explicit synthetic-content answer, and music-video preview. Keep this separate from Facebook/TikTok/Bluesky captions.
4. **Review:** owner signs in with GitHub, reviews the *exact saved version* and media, accepts rights/audience disclosures, and gives the existing approval PIN. Maintain CSRF, same-origin, lockout, version fencing and atomic claims.
5. **Upload:** approved, immutable target moves through a resumable YouTube upload with durable checkpoints. Default to private pending final owner publication review. The upload request must not be directly exposed through the assistant connector.
6. **Reconcile:** store the returned video ID and session checkpoint before any additional external side effect. If the final upload response is ambiguous, enter a manual reconciliation state; do not automatically create another video. Poll YouTube processing and show an owner-facing Studio link.
7. **Playlist:** add to the explicitly approved Free Song Sunday playlist only once. Check existing membership or persist a distinct completion checkpoint. Playlist failure must not trigger a second video upload.
8. **Release:** for the initial workflow the owner uses YouTube Studio to verify the private video and choose when it goes public. Treat `uploaded`, `processing`, `private`, `scheduled`, `public`, `failed` and `needs reconciliation` as distinct outcomes.

## Platform facts, checked 16 November 2026

1. **Uploads from unaudited API projects are no longer locked private.** The Data API revision of 2 November 2026 reversed the July 2020 rule. An earlier note in this file said the opposite and was wrong. Consequence: a `videos.insert` that omits `status.privacyStatus` now defaults to **public**. Every upload must send `part=snippet,status` with an explicit `privacyStatus`, and must read the returned resource and stop with an alarm if it is not the approved value. `YOUTUBE_INSERT_PARTS` and the fixed `"private"` in `src/youtube-metadata.ts` encode this.
2. **Required Minimum Functionality.** An API client that uploads must let the user set the title and description and choose public, private or unlisted. A private-only uploader does not meet that wording. See Owner decision 2.
3. **Quota.** `videos.insert` has its own bucket: 1 unit per call, 100 calls a day by default. `playlistItems.insert` costs 50 units from the general bucket. Neither limits a weekly upload.
4. **OAuth scopes.** `youtube.upload` is enough for `videos.insert`. `playlistItems.insert` needs `youtube`, `youtube.force-ssl` or `youtubepartner`, which also allow editing and deleting the channel's videos. Adding the playlist step therefore widens what a leaked token can do. See Owner decision 3.
5. **Refresh tokens.** While the Google OAuth consent screen is external and in "Testing", refresh tokens expire after 7 days, which breaks a weekly upload. The screen must be "In production" (unverified is acceptable for a single owner), followed by one fresh authorisation. A refresh token unused for six months also stops working.
6. **Altered or synthetic content.** YouTube's help page lists synthetically generated music among the content a creator must disclose. Free Song Sunday tracks therefore need an explicit owner answer on every video; the validator now refuses a draft without one. The flag does not name a tool, so the house rule against naming generative tools in copy is unaffected.
7. **Thumbnails.** `thumbnails.set` is a separate call (files up to 50 MB since September 2026) and a separate failure point. Not verified here: whether the channel must be phone-verified for custom thumbnails.

## Division of work

- **GS Poster** owns the words and the owner's approval: YouTube title, description, tags, Patreon post, audience, rights and synthetic-content answers, checked by `src/youtube-metadata.ts` against YouTube's limits and the house rules.
- **GS Reels** owns the file: render, private upload, playlist, upload record.
- **The bridge between them is not designed yet** (Owner decision 1). Until it is, GS Poster makes no YouTube API call and stores no Google credential.

## Phases

**Phase 1, manual assist (no Google login in GS Poster).** A YouTube target on the draft: the fields above, live validation, copy buttons, and an "Open YouTube Studio" button that is logged and greyed out once pressed, the same pattern as `src/x-share.ts`. Recording the press sends nothing, so it needs session, same-origin and CSRF but no PIN. The owner uploads in Studio or lets GS Reels upload. This needs a database column or table for the target and is a Full review, but adds no external side effect.

**Phase 2, approved automated private upload.** Only after the three owner decisions and the GS Reels fixes below. The safety design in "Target pipeline" stays as written.

## Owner decisions (open)

1. **How does an approved GS Poster draft reach GS Reels?** Today a push of `video.json` to the GS Reels default branch is the only trigger, so whoever merges there (an agent) starts an upload to the owner's channel with no sign-in and no PIN. Options: (a) keep it manual, the owner or an agent copies the approved metadata into `video.json` and the owner merges; (b) GS Poster, after PIN approval, hands GS Reels a signed, one-use approval record that the workflow verifies before uploading. Option (b) is the only one that carries the PIN approval across, and is new security-sensitive work.
2. **Visibility choice.** Keep private-only and accept that it does not match the Required Minimum Functionality wording (a single-owner tool that is never audited or offered to others), or add a three-way choice that defaults to private. Because of fact 1, choosing "public" would now really publish, so that choice must sit behind the same PIN approval as every other publish in GS Poster. Not legal advice; the owner decides.
3. **Playlist by API or by hand.** By API needs the wide `youtube` scope in a stored token. By hand in Studio keeps the token at `youtube.upload`, which cannot edit or delete anything.

## GS Reels uploader: required fixes before it is merged or trusted

Found by reading `6d67321`. GS Poster agents cannot fix these here; they belong in a GS Reels pull request.

1. **A lost final response can cause a second upload.** If the last `PUT` succeeds but the response is lost, `resume_offset` gets a 200 or 201, discards the body that contains the video ID and returns `size`; the loop then sends an empty range, fails, prints "Push the plan again to retry", and no `uploaded.json` exists, so the next run uploads the video again. Fix: on 200/201 from the status query, read the ID and treat the upload as done; if the outcome cannot be determined, write a `needs-reconciliation` record that blocks any further upload of that slug until a human clears it.
2. **A runner that dies after the upload and before the record is committed** leaves the same gap. Write and push an `uploading` record with the session URI before sending bytes, and refuse to start a new session while one exists.
3. `selfDeclaredMadeForKids` is hardcoded `False` and `containsSyntheticMedia` is never sent. Both must come from the approved metadata.
4. No house-rule or limit validation of title, description or tags. Port the rules in `src/youtube-metadata.ts` to `reel.py video-check`, or have GS Poster emit the already validated block.
5. The response's `status.privacyStatus` is not checked against `private` (fact 1).
6. The stored token needs the wide `youtube` scope because of the playlist step (Owner decision 3).
7. The trigger carries no owner approval (Owner decision 1).

## Interface compliance gate before live uploads

No uploader launches from either repository until Owner decisions 1 to 3 are recorded here and the GS Reels fixes 1, 2, 3 and 5 are merged and independently reviewed.

Official documentation:
- https://developers.google.com/youtube/terms/required-minimum-functionality
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
- https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/insert
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.google.com/youtube/data/revision_history (2 November 2026 entry)
- https://developers.google.com/identity/protocols/oauth2 (refresh token expiration)
- https://support.google.com/youtube/answer/14328491 (altered or synthetic content)

## Foundation included in this branch

- `src/youtube-metadata.ts`: pure metadata model and validation for a Free Song Sunday YouTube video. Enforces YouTube title length, description byte length, supported characters, bounded tags, explicit audience declaration, copyright confirmation, a reviewed HTTPS Patreon post URL, optional playlist ID and an explicit synthetic-content answer. The Patreon check covers the shape of the link only; it cannot tell whether the post is free or public, which the owner confirms at review. Reuses the central `src/validate.ts` house-rule checks for user-facing copy.
- `buildPrivateYouTubeMusicVideoMetadata`: produces a private-only YouTube insert *body*, not an authorization or upload. No tokens, session, video bytes, network requests, publishing or scheduling APIs.
- `youtubeStudioVideoUrl`: only produces Studio links from canonical video identifiers.
- `test/youtube-metadata.test.ts`: validation, security-negative, disclosure and private-only tests.

**Not implemented:** database migration, new drafting tools, storage changes, Google authorization, media transfer, upload service, playlist mutation, status polling, owner user interface or deploy changes. This branch changes no existing publication entry points and must not be described as a working YouTube publisher.

## Required full security review

This feature ultimately adds account authorization and a private-media external transfer. Classify the *integration* as **Full review**, even if this first pure helper is bounded. Before connecting a route inspect: `src/index.ts`, `src/web.ts`, `src/mcp.ts`, `src/db.ts`, `src/env.ts`, `src/upload.ts`, `src/draft-editor.ts`, `src/publish.ts`, `src/instagram-publish.ts` and the corresponding tests. Inventory the exact entry points, trust model, invariants, state transitions, indeterminate failure cases, recovery actions and permissions. Independent Claude review must name its exact revision. No self-merge, no production publishing test until owner approval, and no workflow modification that deploys branches other than `main`.

A dedicated **staging environment** is recommended before integration of a live YouTube token, not necessarily a permanent staging branch. Keep separate Cloudflare Worker name, private R2 bucket, D1 database, OAuth clients and approved test channel credentials. A feature branch or draft pull request alone is not an isolated staging environment.

## Future phases, not initial blockers

- Reuse GS Reels rendering presets for vertical item reveals, three-item Shorts, product teasers and automated covers.
- Prepare YouTube Community posts for manual owner publication; official public video upload methods are not Community-post creation endpoints.
- YouTube processing, playlist and engagement analytics after first safe private upload.
