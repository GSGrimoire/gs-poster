# YouTube / Free Song Sunday integration

**State:** foundation only; no YouTube target is active, no credentials are configured, no video is uploaded, and no production deployment is authorized by this branch.

**Plan status:** revised 16 November 2026 after an independent full review (Claude) of the plan, this branch and the existing GS Reels uploader. The platform facts below were checked against Google's own pages on that date. The owner's three decisions of 16 November 2026 are recorded under "Owner decisions" and in the header of `src/youtube-metadata.ts`; they replace the earlier open questions.

**Asana scope:** https://app.asana.com/1/1199525921817881/project/1219262183442034/task/1220546143063489

## Decision and existing assets

The first use case is an existing, finished MP4 music video: tabletop roleplaying ambience, usually one illustration with minimal animation, referring viewers to a relevant recent Patreon product. This is a regular landscape YouTube video, not a Shorts conversion.

GS Reels already has a renderer and a private YouTube uploader on the **unmerged** `claude/youtube-music-video` branch of the private `GSGrimoire/gs-reels` repository (commit `6d67321`, 25 October 2026: `tools/youtube_upload.py`, `.github/workflows/youtube.yml`). On a push of `youtube/<slug>/video.json` to the default branch it renders with FFmpeg in GitHub Actions, uploads as private with a resumable upload, adds the video to the playlist in `youtube/config.json` and commits an `uploaded.json` record. It holds the rendered file where it is made, so it has no file-size problem.

**There must be exactly one uploader, and by decision D1 it is GS Poster.** GS Reels keeps rendering; its upload script and workflow are not merged and are retired once GS Poster can upload. Its defects are kept below as requirements for the GS Poster adapter.

Cloudflare Workers are well suited to coordination, approval, private storage and upload bookkeeping, not full-length audiovisual encoding. The current GS Poster video intake limit is 20 MB. Plan a separate, integrity-checked large-file route before accepting full-length music videos. Cloudflare Stream can transcode existing videos but is not the music-plus-image compositor for this use case.

## Target pipeline

1. **Source:** owner supplies the completed MP4, or GS Reels renders it from approved audio and artwork. Record provenance, copyright and usage rights; do not persist source media in the public GS Poster GitHub repository.
2. **Private intake:** transfer the verified original into private object storage (or securely refer to a vetted GS Reels output), record size and digest, require owner scoping, and never expose unrestricted public media URLs.
3. **Draft:** prepare per-target YouTube title, description, link to the free Patreon post, optional playlist, tags, audience selection, explicit synthetic-content answer, and music-video preview. Keep this separate from Facebook/TikTok/Bluesky captions.
4. **Review:** owner signs in with GitHub, reviews the *exact saved version* and media, accepts rights/audience disclosures, and gives the existing approval PIN. Maintain CSRF, same-origin, lockout, version fencing and atomic claims.
5. **Upload:** the approved, immutable target moves through a resumable YouTube upload with durable checkpoints, started only by cron from a job the PIN approval created. The insert is **always private**, whatever visibility was approved. No assistant connector tool can start, retry or release it.
6. **Reconcile:** store the returned video ID and session checkpoint before any additional external side effect. If the final upload response is ambiguous, enter a manual reconciliation state; do not automatically create another video. Poll YouTube processing and show an owner-facing Studio link.
7. **Playlist:** add to the explicitly approved Free Song Sunday playlist only once. Check existing membership or persist a distinct completion checkpoint. Playlist failure must not trigger a second video upload.
8. **Release:** once YouTube reports processing succeeded, a separate checkpointed `videos.update` applies the PIN-approved visibility (public by default, or unlisted; nothing is sent for private). It sits behind a one-way `releasing` barrier like Instagram's `sending`: an unclear result is never resent automatically and is closed only by a PIN-gated "I checked YouTube" action. Treat `uploading`, `processing`, `private`, `releasing`, `public`, `unlisted`, `failed` and `needs reconciliation` as distinct outcomes.

## Platform facts, checked 16 November 2026

1. **Uploads from unaudited API projects are no longer locked private.** The Data API revision of 2 November 2026 reversed the July 2020 rule. An earlier note in this file said the opposite and was wrong. Consequence: a `videos.insert` that omits `status.privacyStatus` now defaults to **public**. Every upload must send `part=snippet,status` with an explicit `privacyStatus`, and must read the returned resource and stop with an alarm if it is not the approved value. `YOUTUBE_INSERT_PARTS` and the fixed `"private"` in `src/youtube-metadata.ts` encode this.
2. **Required Minimum Functionality.** An API client that uploads must let the user set the title and description and choose public, private or unlisted. Decision D2 meets it: the owner chooses one of the three in the editor and approves it with the PIN.
3. **Quota.** `videos.insert` has its own bucket: 1 unit per call, 100 calls a day by default. `playlistItems.insert` costs 50 units from the general bucket. Neither limits a weekly upload.
4. **OAuth scopes.** `youtube.upload` is enough for `videos.insert`. `playlistItems.insert` needs `youtube`, `youtube.force-ssl` or `youtubepartner`, which also allow editing and deleting the channel's videos. Decision D3 accepts this; see the safeguards there.
5. **Refresh tokens.** While the Google OAuth consent screen is external and in "Testing", refresh tokens expire after 7 days, which breaks a weekly upload. The screen must be "In production" (unverified is acceptable for a single owner), followed by one fresh authorisation. A refresh token unused for six months also stops working.
6. **Altered or synthetic content.** YouTube's help page lists synthetically generated music among the content a creator must disclose. Free Song Sunday tracks therefore need an explicit owner answer on every video; the validator now refuses a draft without one. The flag does not name a tool, so the house rule against naming generative tools in copy is unaffected.
7. **Thumbnails.** `thumbnails.set` is a separate call (files up to 50 MB since September 2026) and a separate failure point. Not verified here: whether the channel must be phone-verified for custom thumbnails.

## Owner decisions (Gus, 16 November 2026)

**D1. GS Poster is the release tool, not a production studio.** Media is produced elsewhere, in Claude or ChatGPT sessions and in GS Reels, and the finished file is pushed to GS Poster, which releases it after PIN approval. GS Poster therefore owns the YouTube upload. Making media inside GS Poster is not planned.

**D2. YouTube is released by PIN approval, like the other platforms, and public by default.** The owner chooses public, unlisted or private on the draft; the editor preselects public (`YOUTUBE_DEFAULT_VISIBILITY`). If public release cannot be made to work at first, ship with private and add public afterwards; fact 1 above means nothing on YouTube's side prevents it today.

**D3. GS Poster handles the playlist and other convenience steps itself, and may hold the wide login this needs.** The adapter requests the single scope in `YOUTUBE_OAUTH_SCOPE`. In plain words: that login can upload, add to playlists, and also edit or delete videos on the channel, so if it leaked, someone else could too. Safeguards that follow from it: the refresh token is a Worker secret only, never in D1, logs, error text or any tool response; connecting or disconnecting the YouTube account needs the same sign-in, CSRF, same-origin and PIN controls as TikTok account administration; the adapter calls only `videos.insert`, `videos.update` (status only), `videos.list`, `playlistItems.list` and `playlistItems.insert`, and never any delete method; after authorisation the adapter checks that the token belongs to the expected channel ID and refuses otherwise.

These three are also in the header of `src/youtube-metadata.ts` and enforced by its tests. Changing any of them needs Gus's explicit go-ahead.

## Division of work

- **Claude, ChatGPT, GS Reels:** make the finished MP4 and the draft text.
- **GS Poster:** private intake of the file, the YouTube target and its validation, PIN approval, upload, visibility release, playlist, status and recovery.

## Build order

Each step is its own pull request and a Full review. Nothing goes live before step 5.

1. **Large-file intake.** The current video limit is 20 MB (`src/upload.ts`); a music video is larger. Add a size- and digest-checked route into private R2 (multipart or streamed), with a stated maximum, the same one-use hashed-token rules as `PUT /upload/:id/:token`, and the `request_upload` connector flow so an LLM session or GS Reels can push the file. Not verified here: the Worker request-body limit on the current Cloudflare plan, which decides between a single streamed PUT and R2 multipart.
2. **YouTube target on the draft.** Database migration and editor fields for everything in `YouTubeMusicVideoDraft`, including visibility with public preselected, validated live and on save by `src/youtube-metadata.ts`. Connector tools may draft these fields; none may approve or release.
3. **Account connection.** Google OAuth with `YOUTUBE_OAUTH_SCOPE`, consent screen "In production", PIN-gated connect and disconnect, channel-ID check, staging Worker, R2, D1 and OAuth client first.
4. **Upload job.** Created only by the PIN approval, which freezes the text, media digest and visibility. Cron claims with a lease, saves the resumable session URI before sending bytes, streams from R2 in chunks, stores the video ID before anything else, and verifies the returned `privacyStatus` is `private`.
5. **Release and playlist.** After processing succeeds: obtain a fresh owner-authorized `videos.list(part=status)` readback for the verified video, and make `buildYouTubeReleaseUpdate` carry forward mutable `status.license`, `status.embeddable` and `status.publicStatsViewable` while applying the approved visibility behind the `releasing` barrier. Refuse any incomplete, non-private, scheduled or approval-conflicting status for manual reconciliation; never silently reset Studio preferences. Check the owner/channel and approved job identity at the call boundary. Then the playlist step (check membership with `playlistItems.list` first, own checkpoint; its failure never re-uploads or re-releases). Then retire the GS Reels upload script.

Scheduling: a planned publish time means the release step waits until that time; the upload and processing happen earlier. Do not use YouTube's own `publishAt` until this has been reviewed, because it only works on private videos and would move the release moment out of GS Poster's control.

## Requirements carried over from the GS Reels uploader

Found by reading `gs-reels@6d67321`. The GS Poster adapter must not repeat them, and each needs a test.

1. **A lost final response must not cause a second upload.** There, when the last `PUT` succeeds but the response is lost, the status query's 200/201 body with the video ID is discarded and the next run uploads again. Here: on 200/201 from the status query read the ID and finish; if the outcome cannot be determined, go to `needs reconciliation`, which blocks any new upload for that target until the PIN-gated human action.
2. **A crash between upload and record must not cause a second upload.** Persist the session URI before the first byte, and never open a second session for the same approved job.
3. Audience and synthetic-content answers come from the approved draft, never hardcoded.
4. The response's `status.privacyStatus` is checked after insert and after release.
5. The trigger is the PIN approval, never a repository push.

## Gate before any live upload

No YouTube credential is configured and no upload runs until build steps 1 to 4 are merged and independently reviewed, the staging environment exists, and the CLAUDE.md hard rule for YouTube is in place.

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
- `buildPrivateYouTubeMusicVideoMetadata`: produces the always-private YouTube insert *body*, not an authorization or upload. No tokens, session, video bytes, network requests, publishing or scheduling APIs.
- `buildYouTubeReleaseUpdate`: produces the later status-only update *body* that applies the approved visibility; null for private.
- `YOUTUBE_VISIBILITIES`, `YOUTUBE_DEFAULT_VISIBILITY`, `YOUTUBE_OAUTH_SCOPE`, `YOUTUBE_INSERT_PARTS`: decisions D2 and D3 and fact 1 as constants.
- `youtubeStudioVideoUrl`: only produces Studio links from canonical video identifiers.
- `test/youtube-metadata.test.ts`: validation, security-negative, disclosure, visibility and always-private-insert tests.

**Not implemented:** database migration, new drafting tools, storage changes, Google authorization, media transfer, upload service, playlist mutation, status polling, owner user interface or deploy changes. This branch changes no existing publication entry points and must not be described as a working YouTube publisher.

## Required full security review

This feature ultimately adds account authorization and a private-media external transfer. Classify the *integration* as **Full review**, even if this first pure helper is bounded. Before connecting a route inspect: `src/index.ts`, `src/web.ts`, `src/mcp.ts`, `src/db.ts`, `src/env.ts`, `src/upload.ts`, `src/draft-editor.ts`, `src/publish.ts`, `src/instagram-publish.ts` and the corresponding tests. Inventory the exact entry points, trust model, invariants, state transitions, indeterminate failure cases, recovery actions and permissions. Independent Claude review must name its exact revision. No self-merge, no production publishing test until owner approval, and no workflow modification that deploys branches other than `main`.

A dedicated **staging environment** is recommended before integration of a live YouTube token, not necessarily a permanent staging branch. Keep separate Cloudflare Worker name, private R2 bucket, D1 database, OAuth clients and approved test channel credentials. A feature branch or draft pull request alone is not an isolated staging environment.

## Future phases, not initial blockers

- Reuse GS Reels rendering presets for vertical item reveals, three-item Shorts, product teasers and automated covers.
- Prepare YouTube Community posts for manual owner publication; official public video upload methods are not Community-post creation endpoints.
- YouTube processing, playlist and engagement analytics after first safe private upload.
