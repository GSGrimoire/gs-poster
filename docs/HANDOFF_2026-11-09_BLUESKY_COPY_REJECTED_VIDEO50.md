# GS Poster: Bluesky photo copy, rejected draft return, larger video uploads

Session: ChatGPT-1 | Implementer
GitHub identity: GSGrimoire
Date: 2026-11-09
Review depth: **Full review required**.
Base: main at 0a661e5e37834bc23d0e9d69ecafff34aa3335ee.
Branch: feature/bluesky-gallery-redraft-video50-20261109.
Final pinned head: obtain from GitHub when implementation is complete.
Deployment: **not authorized**. Do not merge without independent source review and successful CI.

## User request and scope

1. Copy photos attached to an existing post into a later-enabled Bluesky gallery using per-photo Copy buttons or desktop drag-and-drop. Never remove source media; copy saved references only. Bluesky has at most four photos, with a separate accessibility description for each.
2. Retain existing per-platform photo drag ordering and arrow buttons. Add drag ordering to the initial new-draft media gallery, keeping the photo record, platform checkboxes and description together.
3. Give rejected, unapproved posts an explicit Return to drafts button in the editor and draft listing. This action needs signed-in owner access, CSRF, same origin and optimistic version fence, but never a PIN because it never approves, schedules or publishes.
4. Expand MP4 input from 20,000,000 to 50,000,000 bytes in private grants, browser checks, GitHub MP4 read and private import, and tool documentation. 50 MB is an intentionally bounded application limit, not a promise of provider acceptance.

## Affected entry points and trust model

- Browser GET /post/:id and /draft-editor.js: render and stage source selections. Source-image previews use the existing same-origin media-proxy pool. Dragging cannot submit an arbitrary URL.
- POST /post/:id/save: authenticated, CSRF, same-origin and version-fenced. Parser converts a bounded comma-separated list of indices into URLs from postPhotos(current post), preserving independent Facebook and TikTok galleries. D1 save remains atomic and unapproved.
- Browser GET /new and /new-draft.js: new unsaved image cards reorder without changing attachment references or source bytes. Selected platform and alternative text fields remain attached to image objects.
- POST /post/:id/return-to-drafts: authenticated, CSRF, same-origin and version-fenced. Only status rejected with approved_at null is eligible. Delegates to existing reopenFailedDraft guard, which refuses a Facebook remote ID, active/published Bluesky target or active Instagram publication. No PIN, publication or scheduling transition.
- Request-upload and private one-time PUT /upload/:id/:token: MP4 maximum is 50,000,000 bytes. Existing token hash, one-use claim, stored ownership, magic-byte validation, status fencing, storage accounting and R2 access rules must remain intact.
- GitHub-hosted video read / preparation, web draft media uploader, new draft uploader and assistant-facing tool descriptions share the 50 MB ceiling. No new publishing endpoint or provider adapter is introduced.
- Existing publisher, cron, private-media readback, upload retention, quotas, TikTok inbox and Instagram output remain security-critical unchanged dependencies. A larger MP4 could increase Worker memory pressure, especially in hash-verified copies.

## Invariants and failure cases to review

- Only existing post media, resolved server-side, can be copied into Bluesky. Malformed, repeated and out-of-range indices are rejected. An attempt that exceeds four images fails without changing the original draft.
- Copying and reordering never changes eligibility for publishing. A missing Bluesky image description blocks approval under existing readiness validation.
- A stale version or already approved/released post cannot be reopened or edited. Rejected-return action cannot clear an active or ambiguous publisher job.
- Uploads above 50,000,000 bytes fail before storage. Unknown upload states are never assumed successful; no partially stored media is attached.
- One-time grants can consume quota reservations and are not retries after uncertain R2 writes. No new public URL for private media is introduced.
- Memory: 50 MB video preparation reuses the existing underlying buffer where possible, rather than making an additional 50 MB clone. A live 40 MB MP4 across each publishing target has not been tested.
- On network interruption, autosave must retain staged selections and avoid sending approval requests. User-visible errors should prevent silent media disappearance.
- Changes do not modify GitHub login allowlists, PIN, publication claim, automatic retry policy or deployment workflow.

## Evidence and review gate

Added real web-route regression tests in test/photo-order.test.ts and test/draft-editor.test.ts, and upload grant boundary tests in test/upload.test.ts. Verify the CI run against the final head, including `npm run check` and Wrangler dry-run. Tests do not prove real browser drag behavior, actual 40 MB upload under Cloudflare memory limits, or live Facebook, Bluesky, TikTok and Instagram acceptance. Separate independent review session or qualified human must inspect the complete affected security path and pinned head before merge or deployment.

## Additional owner request: Planner live clock and Month view (2026-11-09)

Added within this same draft pull request to allow one combined independent review.

- `src/calendar.ts`: a Copenhagen-zone current-time line is displayed only for today's Week column, updated every minute, with automatic initial scroll to the line and a day-header update across midnight. The Week 30-minute slots and signed-in drag-to-reschedule form remain unchanged.
- `src/calendar.ts`: added strict YYYY-MM parsing, month navigation, Sunday-to-Saturday grid boundaries and daylight-saving-aware UTC range conversion. Month cells show every returned post for each day with a thumbnail when artwork exists, status, selected platforms, and direct post link. Month is **read-only**: no drag-to-reschedule, publish or approve action. Unsheduled drafts are labelled as unscheduled and shown on creation day; clicking the date switches to the Week scheduling view.
- `src/web.ts`: existing authenticated `/` and `/calendar` routes accept `view=month&month=YYYY-MM` while preserving `view=week&week=YYYY-MM-DD` and legacy defaults. Invalid periods fall back to the current period. Month data loading uses a full date range including boundary weeks; no date/time or post identity is taken from arbitrary user-supplied URLs.
- `src/db.ts`: monthly calendar queries no longer silently truncate after 500 records, while the week query stays capped at 500. Review load and memory implications for unusually high-volume months.
- `test/calendar.test.ts`: month date boundaries (including Copenhagen daylight saving), month card rendering and escaping, navigation, time-line update behavior.
- `test/draft-editor.test.ts`: authenticated month/week route tests, thumbnails and no publishing side effects.

**Review focus:** verify every visible post corresponds to the same authenticated private-media proxy, the new Month route never changes publishing state, input month validation and UTC boundary behavior around daylight saving are correct, and the Week current-time overlay does not intercept drag/click interactions. Month query unbounded result volume is a capacity limitation requiring review. No actual browser interaction, visual screenshot or production deployment verification has occurred.

**Combined gate:** continue to require a separate reviewer for this pull request's full private-media and publication-path review. Only the reviewer/owner should authorize merge and deployment after CI and security inspection. Re-pin the exact head commit after all changes.


## Implementer response to independent review V1-V4 (10 November 2026)

Original independent review of pinned head `351a8778ed89a46c10217c8196666f943d7408fd` concluded **changes required** (see PR review `5832979779`). The findings remain in the PR record. This subsequent implementation requires **another independent full review at the final head**, not a self-approval.

- **V1, 50 MB media memory:** `prepareLinkedVideo` now opens an allowlisted GitHub source as a readable response stream without accumulating a full `fetchVideo()` buffer. `handleUploadPut` uses R2 multipart for video, one 5 MiB part at a time; final non-full part allowed. After `complete()`, `verifyStoredUploadParts` checks every part through a 5 MiB range read, matching SHA-256 digests and object total size before setting the upload row to `stored`. No full-size source or verification ArrayBuffers are retained in the preparation path. The one-use bearer token, owner check and optimistic draft replacement remain unchanged. Ambiguous multipart completion is not retried or reopened.
- **V2, bounded actual input:** image uploads now count streamed bytes before allocating the maximum 10 MiB buffer. Videos count actual bytes before copying them into 5 MiB parts, and abort incomplete multipart uploads on size mismatch. Public PUT still requires `Content-Length`; trusted internal GitHub import may omit it, but never bypasses the maximum byte cap. Added streamed overrun tests independent of declared headers.
- **V3, observational Month GET:** the new Month view bypasses the legacy `refreshScheduled` and `reconcileOldTikTokInboxDrafts` page-load calls. Week retains the old compatibility behavior. Added a real dashboard regression with a legacy TikTok inbox record that would otherwise be automatically reclassified on GET.
- **V4, bounded Month capacity:** month database query uses a deterministic 750-row page with one extra sentinel for `hasNext`; links for next/previous posts are shown, with an explicit warning that a busy day may span pages. The query no longer retrieves an unbounded number of rows or silently loses posts beyond 500.

**Tests/evidence**: local Workerd/Miniflare integration test streams a generated 40,000,000-byte GitHub MP4 into multipart storage, checks owner status and final R2 size without full-buffer readback; separate corrupted-readback and stream overrun tests protect the same failure mode. Pagination test checks 810 records across pages. The final GitHub Actions typecheck, test and Wrangler dry-run result must be pinned after the last commit.

**Remaining acceptance before deployment:** an actual 40-50 MB Cloudflare test with memory and error telemetry, a browser visual and drag interaction check, and independent full review of the changed upload/persistence path. Local Miniflare success alone is not production memory proof. No merge, deployment or provider publishing was performed by this implementer.


## Implementer response to independent review F1 and F2 (10 November 2026)

Independent re-review of pinned head `f7b151371d8e4c7e18204a74b6db1817d393ae6d` in GitHub review `5843480124` found two new items. They are addressed in the same draft pull request.

- **F1, Facebook mismatch:** the established 20,000,000-byte Facebook simple multipart limit is now a named `FACEBOOK_VIDEO_MAX_BYTES` constant and `assertFacebookVideoSize` invariant in `src/facebook.ts`. The signed-in release endpoint rejects oversized Facebook-selected video before TikTok transfer, Instagram queue or Facebook/Bluesky approval claims, including mixed selections. `approveAndPublish` preflights the saved version before `claimForPublish`, reuses already-read bytes and preserves the optimistic version fence. `retryFailedFacebook` preflights before changing a failed post to publishing. Existing direct transport retains the 20 MB check as defense in depth. The editor, release panel, private media picker, new draft setup and README distinguish 50 MB private storage from 20 MB Facebook publishing. Tests cover the exact size boundary, mixed TikTok selection, direct publish and retry without external calls or state mutation.
- **F2, quota reservations after failed uploads:** `src/upload.ts` now recognizes terminal `failed` rows, excluded from the existing accounting sum and never ready for attachment. Invalid pre-write headers and bodies consume the failed token and free reservations. The multipart writer reports conclusive no-write and confirmed abort separately from an uncertain abort, upload-part acknowledgment or completion. Only definitely absent or confirmed deleted objects transition to failed. Ambiguous writes continue to be `uploading` and retain their entire quota reservation, with a consumed token and no draft-ready status. Tests cover missing/oversized header, malformed/truncated MP4, stream overrun, length mismatch after starting multipart, confirmed abort, failed abort, uncertain completion, replay refusal, stored-byte accounting and corruption readback cleanup.

**Exact-head gates:** require `npm run check`, Wrangler dry-run and a newly pinned independent review. Live Cloudflare 40,000,000-byte and near-50,000,000-byte uploads and real-browser behavior remain mandatory and **are not yet verified**. An isolated staging test matrix is in `docs/PR90_STAGING_ACCEPTANCE.md`; it requires separate databases, buckets, namespace, hostname, no provider credentials and no scheduled publishing. No staging or production deployment was made by this implementer. Production merging remains blocked until live evidence and independent signoff.
