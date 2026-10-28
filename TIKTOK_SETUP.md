# TikTok connection and content posting

Current GS Poster feature set: Login Kit, inbox uploads, and private-only Direct Post testing for videos and photo carousels. No automatic TikTok calendar scheduling or public Direct Post is implemented.

## First: connect TikTok

1. In TikTok for Developers, open **GS TT Poster**. Enable Login Kit and Content Posting API.
2. Register `https://gs-poster.goofyspook.workers.dev/tiktok/callback` as the exact Web redirect URI.
3. Enable `user.info.basic`, `video.upload`, and optionally `video.publish` for Direct Post testing.
4. In the Cloudflare **gs-poster** Worker, store `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, and `TIKTOK_TOKEN_ENCRYPTION_KEY` as encrypted secrets. Never put real credentials in GitHub.
5. Go to `https://gs-poster.goofyspook.workers.dev/tiktok/settings` and select Connect TikTok. The editor must explicitly consent to each requested permission in TikTok. If you previously connected without `video.publish`, disconnect and reconnect with that scope selected.

## Second: verify the media URL prefix

**Important for all photo carousels and direct video posts:** TikTok uses `PULL_FROM_URL`. The public media origin must be verified in the TikTok app's **URL Properties**.

The prefix to verify is:

`https://gs-poster.goofyspook.workers.dev/tiktok/media/`

TikTok will provide a verification text file. Enter its filename and exact contents on the GS Poster TikTok settings page. The file is served publicly as plain text from that path, without a login or redirect. After hosting it, complete the verification process in TikTok's portal. GS Poster cannot confirm the verification state itself.

Only the exact verification file is public before a transfer. When the editor explicitly authorizes a transfer using the approval PIN, GS Poster creates random media URLs valid for three hours. Private R2 originals remain private, and public photo responses are converted to WebP using the Cloudflare Images binding. URLs are unlisted, cannot reveal private object identifiers, and expire automatically.

## Third: prepare and send a post

1. Create a new post in GS Poster, select TikTok and **Images** or **Video**. Up to 35 photos (TikTok), up to four photos if also targeting Bluesky, or one MP4 up to the existing GS Poster limit.
2. Attach images, write a caption and review the draft. TikTok-only drafts do not create a Facebook or Bluesky target.
3. Open the post's **Review TikTok posting options** page.
4. Choose either:
   - **Send to TikTok inbox**: `video.upload`. Video sends a binary MP4; photo carousel uses TikTok's `/v2/post/publish/content/init/` endpoint with `post_mode=MEDIA_UPLOAD`, `media_type=PHOTO`, and verified image URLs. The creator then finishes publishing inside TikTok.
   - **Direct Post test**: `video.publish`. Requires fresh creator privacy options, selected permission, explicit approval PIN and separate confirmation. While the app is unaudited, GS Poster only allows `SELF_ONLY` private posts. Photo carousels and videos use verified URL transfers.
5. Use **Refresh TikTok transfer status** to check processing. A transfer is one-shot, not automatically retried after an uncertain outcome.

TikTok's Upload Video API does not offer a caption field; when uploading a video to the TikTok inbox, set its caption while finishing the post in TikTok. Photo inbox uploads do support titles and descriptions.

## Important Sandbox and review restrictions

- TikTok approval and available scopes determine whether these endpoints work with GS TT Poster in Sandbox. A successful login does not guarantee posting permission.
- Unreviewed applications may be limited to private TikTok accounts and SELF_ONLY posts. TikTok can reject direct posts from public accounts.
- TikTok's review guidelines exclude tools limited solely to managing the developer's own account. The product description, demonstration and public website must accurately represent the intended use. Do not assert approval until TikTok grants it.
- TikTok may require URL ownership verification for the application's About, Terms and Privacy URLs in addition to media delivery.
- GS Poster does not automatically schedule TikTok publication. All TikTok transfers require manual editor approval and PIN.
- Published or inbox-delivered TikTok posts can have different moderation states; GS Poster records and displays the status returned by TikTok.

## Public URLs

- About: https://gs-poster.goofyspook.workers.dev/about
- Terms: https://gs-poster.goofyspook.workers.dev/terms
- Privacy: https://gs-poster.goofyspook.workers.dev/privacy
- Login callback: https://gs-poster.goofyspook.workers.dev/tiktok/callback
- Verifiable pull URL prefix: https://gs-poster.goofyspook.workers.dev/tiktok/media/

## Official developer documentation

- https://developers.tiktok.com/docs/en/login-kit-web
- https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video
- https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- https://developers.tiktok.com/docs/en/content-posting-api-reference-photo-post
- https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- https://developers.tiktok.com/docs/en/content-sharing-guidelines

No credentials, tokens or private draft URLs should be committed to GitHub.
