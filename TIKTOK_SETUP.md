# TikTok video.upload first: operator setup and review

## Implemented in this release

- Public information: `/about`, `/terms`, `/privacy`.
- Web Login Kit callback: `https://gs-poster.goofyspook.workers.dev/tiktok/callback`.
- GitHub-authenticated `/tiktok/settings` page with Connect and Disconnect.
- TikTok login uses a session-bound, one-use authorization state; server-side access and refresh tokens are encrypted in Cloudflare D1 using a dedicated Worker secret.
- Initially request only `user.info.basic` and `video.upload`, **not** `video.publish`.
- An authenticated editor can create a TikTok-only video draft, attach a private MP4, and send it to their TikTok inbox using a separate PIN-confirmed action on the post page. Videos are sent directly as binary MP4 files, so no public video URL or verified image domain is necessary for this phase.
- GS Poster records TikTok's upload ID and permits a manual status refresh. A repeated or uncertain transfer is not automatically retried.

This **does not** publish to TikTok, synchronize TikTok posting times, or add TikTok to automatic calendar releases. The creator must open their TikTok inbox notification, finish editing and tap Publish inside TikTok.

## Developer portal tasks for the operator

1. On [TikTok for Developers](https://developers.tiktok.com/), open the GS Poster app. Add Login Kit for Web.
2. Enter the exact allowed redirect URI: `https://gs-poster.goofyspook.workers.dev/tiktok/callback`.
3. Add Content Posting API, enable the **Upload to TikTok** feature, and request **`video.upload`** approval. Baseline login uses `user.info.basic`. Do **not** request `video.publish` in this first review.
4. Supply the public website `https://gs-poster.goofyspook.workers.dev/about`, Terms `https://gs-poster.goofyspook.workers.dev/terms`, and Privacy `https://gs-poster.goofyspook.workers.dev/privacy`. Review policy wording and provide a dedicated, working privacy contact before submission. TikTok may expect a fully developed public website and an explanation of the restricted editor application.
5. Add the following values to **Cloudflare Worker > Settings > Variables and Secrets** as encrypted secrets. Never put real credentials in GitHub or chat:
   - `TIKTOK_CLIENT_KEY`: TikTok app client key.
   - `TIKTOK_CLIENT_SECRET`: TikTok app client secret.
   - `TIKTOK_TOKEN_ENCRYPTION_KEY`: a separate cryptographically random value of at least 32 characters. Back it up securely: changing it invalidates previously connected TikTok tokens.
   - `TIKTOK_REDIRECT_URI` optional. Leave unset to use the exact callback above.
6. Open `https://gs-poster.goofyspook.workers.dev/tiktok/settings` after Cloudflare secrets are configured. Select `video.upload`, then complete TikTok consent. Verify that only `user.info.basic` and `video.upload` appear in the connected scope list.
7. Attach a private MP4 to a GS Poster video draft. From its post review page select **Send video to TikTok inbox**, confirm the manual publishing rule and enter your PIN. Inspect the transfer status. Open TikTok to finish publication.
8. Prepare screenshots or a short reviewer recording showing the TikTok Connect button, consent, video transfer, status, and the final TikTok inbox notification. Submit the app for review, identifying this as an upload-to-inbox application.

## Architecture and risks

**Private media:** GS Poster uploads files privately to Cloudflare R2. The initial TikTok transfer uses `FILE_UPLOAD`: an authenticated Worker reads the private MP4 and sends it directly to TikTok's signed, time-limited upload endpoint. Public URL ownership verification is therefore **not needed for video.upload** with `FILE_UPLOAD`. Verified public URLs will be relevant later for TikTok photos and `PULL_FROM_URL`.

**Manual release:** TikTok video.upload does not publish or schedule the video at the GS Poster calendar time. The TikTok app may show an inbox notification after processing. The creator must complete the post in TikTok, including caption, sound, visibility and final publication.

**Authorization:** TikTok may not grant requested scopes until developer review. GS Poster does not handle developer-portal approval or enter private credentials.

**Repeated uploads:** The first external send is stored as an irreversible, single-attempt transfer per GS Poster post. A failure or uncertain completion requires manual reconciliation instead of automatic duplicate uploads.

**Next phase:** When upload-to-inbox has passed real-world verification and app review, implement separate `video.publish` consent and creator privacy options, status handling, audit and approved TikTok scheduling. Do not enable direct publishing until that review succeeds.

## Official documentation

- https://developers.tiktok.com/docs/en/login-kit-web
- https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content
- https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video
- https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status
- https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- https://developers.tiktok.com/docs/en/app-review-guidelines
