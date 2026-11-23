# Free Song Sunday on YouTube

The first release is a finished landscape music video with a link to the corresponding free Patreon post. GS Reels renders the video and hands it to GS Poster. Other creators can supply a finished video the same way.

On 23 November 2026 Gus approved manual preparation first and automated upload second. GS Poster is the only future uploader. GS Reels does not upload to YouTube or any other social platform. The 16 November decisions on visibility, playlist handling and channel authorization apply to Phase 2. [Owner decision](https://github.com/GSGrimoire/gs-poster/pull/92#issuecomment-7104686294)

The foundation in [pull request #91](https://github.com/GSGrimoire/gs-poster/pull/91) contains metadata validation and request-body helpers. Phase 1 and Phase 2 each require implementation and review. [Asana scope](https://app.asana.com/1/1199525921817881/project/1219262183442034/task/1220546143063489)

## Phase 1. Prepare in GS Poster and upload in YouTube Studio

1. Add a separate YouTube destination to the draft. Save its title, description, tags, Patreon post URL, audience selection, rights confirmation and synthetic-media declaration. Preserve the other destinations' captions and media decisions.
2. Reuse the foundation validator for field lengths, brand rules, the exact Patreon link in the description and explicit declarations. Gus confirms whether the Patreon post is free and public. Display validation errors and optional notes on the saved draft.
3. Provide **Copy title**, **Copy description**, **Copy tags** and **Copy Patreon link**. Copy the exact saved metadata.
4. Provide **Open YouTube Studio** and **Reopen YouTube Studio** using the same interaction as **Open in X**. Record the first owner-initiated open. Grey out the primary control after the first click and keep a way to reopen Studio. The recorded state is **Studio opened**.
5. Gus selects the account and channel, attaches the video and confirms metadata, rights, audience, disclosure, thumbnail, playlist and visibility in Studio. He uploads and publishes or schedules it there.

The draft save and the Studio-open record use the existing signed-in owner, same-origin and request-forgery checks. Draft saves are version fenced. These actions only write to GS Poster. Phase 1 uses no Google connection, YouTube service calls, server-side transfer or publication.

Acceptance requires a saved and reopened draft, exact copy values, persistent first-open state, accurate status, and desktop and mobile checks. Exercise signed-out requests and stale saves. Run the repository checks and the Cloudflare bundle dry run before independent review.

## Phase 2. GS Poster uploads and releases approved videos

### Owner choices

- **D1. GS Poster is the sole uploader.** GS Reels renders and delivers finished files. Keep its unmerged YouTube upload script and workflow outside the release path.
- **D2. The owner approves visibility.** Offer public, unlisted and private, with public preselected. Upload always starts in private. After YouTube confirms processing, apply the approved visibility at the approved time. The owner reviews the exact saved version and enters the approval code.
- **D3. GS Poster manages the selected playlist.** The owner accepted the broader YouTube authorization scope required for that operation. Use the authorized account only for the expected channel and limit the implementation to the required operations. Keep the refresh token and client secret in Cloudflare Worker secrets. Protect connect and disconnect with the existing session, same-origin, request-forgery, approval-code and lockout controls.

### Build and verification order

| Work | Acceptance |
| --- | --- |
| Private video intake | Verify the original size and digest, record provenance, and bound media type, file size, time and quota. Preserve owner-only access and use the reviewed large-video route when available. [Private video intake](https://github.com/GSGrimoire/gs-poster/pull/94) |
| Google connection and compliance | Verify the actual consent-screen status, scope, expected channel and quota. Configure and test a persistent owner connection. External apps in Testing can receive short-lived refresh tokens, so confirm the production consent setup before relying on a weekly upload. Verify the applicable upload and visibility rules with YouTube before enabling the adapter. [Google authorization](https://developers.google.com/identity/protocols/oauth2) [YouTube requirements](https://developers.google.com/youtube/terms/required-minimum-functionality) |
| Approved upload job | Approval freezes the exact saved metadata, verified media and digest, expected channel, visibility, playlist and scheduled time. The scheduled Worker claims the job and persists the resumable session before sending media. Honor the provider's confirmed offsets. Store the returned video ID and confirm it is private before further actions. Protect the session address as a credential. [Resumable upload protocol](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol) |
| Ambiguous upload recovery | Read the video ID if a status query confirms success. If initiation or completion remains unclear, stop in **Needs reconciliation** and keep the same job. Require owner confirmation through the existing approval controls before resolving uncertainty. A retry may resume the recorded session only. Never initiate a second upload for the same approval. |
| Visibility and playlist | After processing and at the approved time, read existing video status and preserve mutable settings when applying approved visibility. Use a one-way barrier for release and a separate one-time checkpoint for the playlist. Check membership before insertion. A failed or unclear release or playlist result cannot initiate another upload. [Visibility status correction](https://github.com/GSGrimoire/gs-poster/pull/93) |
| Thumbnails | Gus sets the first thumbnail in Studio. Any later automated thumbnail action needs its own checkpoint and a confirmed video ID. |

Show approved, uploading, processing, private, releasing, public, unlisted, failed and needs-reconciliation states separately. Draft tools may prepare metadata. Worker upload and release operations require an owner-approved job.

Before enabling a live Google connection, independently review the full authorization, storage, approval, transfer and recovery paths. Exercise them in an isolated Cloudflare Worker with its own storage, database, Google client and test channel. Verify token revocation, expired sessions, stale approval, failed processing, lost final responses, playlist duplication and production rollback. Use approved test assets and channel access.
