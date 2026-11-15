# YouTube / Free Song Sunday integration

**State:** foundation only; no YouTube target is active, no credentials are configured, no video is uploaded, and no production deployment is authorized by this branch.

**Asana scope:** https://app.asana.com/1/1199525921817881/project/1219262183442034/task/1220546143063489

## Decision and existing assets

The first use case is an existing, finished MP4 music video: tabletop roleplaying ambience, usually one illustration with minimal animation, referring viewers to a relevant recent Patreon product. This is a regular landscape YouTube video, not a Shorts conversion.

GS Reels already has a renderer and a private YouTube uploader on the **unmerged** `claude/youtube-music-video` branch of the private `GSGrimoire/gs-reels` repository. It renders with FFmpeg and, on approval, can upload privately to a playlist through GitHub Actions. Reuse this rendering capability; first reconcile the unpublished branch and the responsibilities of that uploader before adding a competing GS Poster upload pathway.

Cloudflare Workers are well suited to coordination, approval, private storage and upload bookkeeping, not full-length audiovisual encoding. The current GS Poster video intake limit is 20 MB. Plan a separate, integrity-checked large-file route before accepting full-length music videos. Cloudflare Stream can transcode existing videos but is not the music-plus-image compositor for this use case.

## Target pipeline

1. **Source:** owner supplies the completed MP4, or GS Reels renders it from approved audio and artwork. Record provenance, copyright and usage rights; do not persist source media in the public GS Poster GitHub repository.
2. **Private intake:** transfer the verified original into private object storage (or securely refer to a vetted GS Reels output), record size and digest, require owner scoping, and never expose unrestricted public media URLs.
3. **Draft:** prepare per-target YouTube title, description, link to the free Patreon post, optional playlist, tags, audience selection, optional synthetic-media disclosure, and music-video preview. Keep this separate from Facebook/TikTok/Bluesky captions.
4. **Review:** owner signs in with GitHub, reviews the *exact saved version* and media, accepts rights/audience disclosures, and gives the existing approval PIN. Maintain CSRF, same-origin, lockout, version fencing and atomic claims.
5. **Upload:** approved, immutable target moves through a resumable YouTube upload with durable checkpoints. Default to private pending final owner publication review. The upload request must not be directly exposed through the assistant connector.
6. **Reconcile:** store the returned video ID and session checkpoint before any additional external side effect. If the final upload response is ambiguous, enter a manual reconciliation state; do not automatically create another video. Poll YouTube processing and show an owner-facing Studio link.
7. **Playlist:** add to the explicitly approved Free Song Sunday playlist only once. Check existing membership or persist a distinct completion checkpoint. Playlist failure must not trigger a second video upload.
8. **Release:** for the initial workflow the owner uses YouTube Studio to verify the private video and choose when it goes public. Treat `uploaded`, `processing`, `private`, `scheduled`, `public`, `failed` and `needs reconciliation` as distinct outcomes.

## Interface compliance gate before live uploads

The official YouTube Data API Required Minimum Functionality document states that an upload client must allow the user to choose **public, private or unlisted** visibility, in addition to setting title and description. The first coding slice here deliberately exposes no uploader or user interface, and its metadata helper produces *private-only* payloads. **Do not launch the uploader until the review interface and approved lifecycle satisfy that visibility-choice rule without bypassing the owner's explicit approval and scheduling policy.** A private-first staging step followed by explicit visibility choice may be a viable design, but must be verified during review.

Official documentation:
- https://developers.google.com/youtube/terms/required-minimum-functionality
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
- https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/insert
- https://developers.cloudflare.com/workers/platform/limits/

## Foundation included in this branch

- `src/youtube-metadata.ts`: pure metadata model and validation for a Free Song Sunday YouTube video. Enforces YouTube title length, description byte length, supported characters, bounded tags, explicit audience declaration, copyright confirmation, a reviewed HTTPS Patreon post URL, optional playlist ID and synthetic-media declaration.
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
