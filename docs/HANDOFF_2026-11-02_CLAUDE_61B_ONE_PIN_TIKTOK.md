# GS Poster handoff: #61 part B, TikTok in the same PIN approval (2 November 2026)

**Session:** Claude-1 | Implementer. **Branch:** `claude/61-one-pin-tiktok`, stacked on `claude/61-autosave-schedule` (review and merge part A first, or both together).
**Owner approval:** issue #61 point 5 and the owner clarification of 1 November.
**Pull request:** not opened from this session (connector 403). Open from `https://github.com/GSGrimoire/gs-poster/pull/new/claude/61-one-pin-tiktok`.

## Review depth: Full

Approval and PIN route, TikTok transfer, partial-failure handling. PIN check, lockout, CSRF, same-origin, allowlist, `claimForPublish`, the Facebook queue and the TikTok transfer functions themselves are unchanged.

## What Gus sees

In the draft editor's release form, when TikTok is on, a TikTok section sits **directly above the PIN**:
- "TikTok · 3-photo carousel to your inbox" (ticked by default), with the photos in order or the video.
- The title (the post name) and the saved TikTok caption. Video inbox sends take no caption, so it says so.
- A highlighted warning: **"Sent to your TikTok inbox the moment you approve, even though Facebook and Bluesky are scheduled for Mon 2 Nov, 20:45. Nothing is published on TikTok: you finish and post it in the TikTok app."**
- "AI-generated content (declared to TikTok)" and a required "I have the rights to this media and want it sent to TikTok now."
- A summary: "Now: TikTok inbox / Mon 2 Nov, 20:45: Facebook and Bluesky".
- One button, "Approve selected targets" (or "Approve and send to TikTok inbox" when TikTok is the only target).

Unticking TikTok hides its section and drops the consent requirement. There is no separate options screen and no second send click for drafts. Scheduled and published posts keep the old route. Direct Post stays hidden and is never chosen. Screenshot: `docs/screens/one-pin-release-2026-11-02.png`.

## Server order (`POST /post/:id/approve`)

1. PIN, lockout, CSRF, same-origin, session (unchanged), draft status and `expected_updated_at`.
2. Targets. For TikTok: `tiktokReleasePlan` (new, pure) refuses before anything is sent when:
   - TikTok is not connected or lacks `video.upload`;
   - a transfer already exists that is not `rejected`/`cleared`;
   - there is no media, or the media is not a private upload;
   - there are more than 35 photos, or the caption is too long.
   Consent is required.
3. **Every** Facebook and Bluesky pre-check (media pending, large gallery review, Bluesky rules, release time and rollover, readable media). A Facebook problem stops TikTok too.
4. TikTok send via the **existing** exactly-once functions (`startTikTokContentTransfer` for photos in `MEDIA_UPLOAD`, `startTikTokInboxTransfer` for video), fenced on the same saved version. The transfer row does not change the post version.
5. `approveAndPublish` for Facebook and Bluesky with the same version (unchanged).
6. One page with **separate per-platform outcomes**. A partial result shows the warning banner with both lines. Nothing is retried: the TikTok claim row blocks a resend, and the post is no longer a draft for Facebook.

TikTok alone ignores the calendar time (immediate inbox transfer); the post stays a draft, as with the old TikTok-only flow. TikTok content in the form is never used: caption, media and title come from the saved draft, which autosave (part A) keeps current.

## Tests

`test/one-pin-tiktok.test.ts` (10). Real bundled `handleWeb` in workerd with an outbound recorder that plays TikTok's API and refuses everything else:
- inline form, send-now warning, no options link, no Direct Post;
- autosave sends nothing;
- TikTok-only sends exactly one `content/init` and keeps the post a draft; a second click is refused with no call;
- video sends exactly one `inbox/video/init` and one `PUT /video/`;
- Facebook scheduled + TikTok: one TikTok call, Facebook queued, date unchanged, **zero Facebook calls**;
- TikTok refused: Facebook still approved, both reported, one attempt, row `rejected`;
- unclear outcome: `needs_review`, a later approval cannot resend;
- no transfer when consent is missing, the PIN is wrong, the page is stale, the request is cross-site, the CSRF is forged, or the Facebook time is too close;
- no connection or no inbox permission is refused before sending;
- unticking TikTok releases Facebook alone.

`npm run check`: 279 of 279. Wrangler dry-run OK. Browser check (Playwright, 1500 px and 390 px): no script errors, untick hides the details and removes `required`, no horizontal scroll.

## Live acceptance after deploy (Gus)

Use a real TikTok-only test draft with two photos:
1. Approve once.
2. Check that the carousel arrives in the TikTok inbox, then delete it there.
3. Confirm that a second click says "Already sent to TikTok".
