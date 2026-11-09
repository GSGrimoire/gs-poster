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
