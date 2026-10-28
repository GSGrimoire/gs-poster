# TikTok app review preparation

**Status:** Review narrative and operator checklist. Do not submit until live TikTok login, video transfer and photo transfer have been demonstrated.

## Application description

GS Poster is an editorial calendar and media-sharing service for authorized creators producing tabletop roleplaying game content. It allows authenticated creators to prepare their own original videos and image carousels for Facebook, Bluesky and TikTok.

TikTok Login Kit grants the application specific permissions chosen by the user. With `video.upload`, GS Poster sends videos and photo carousels to the creator's TikTok inbox for editing and manual publication. With optional `video.publish`, the editor may initiate a separately approved Direct Post from the post review screen. Until the TikTok application passes the required audit, GS Poster limits Direct Post tests to private `SELF_ONLY` posts. The editor must choose whether to upload or publish and explicitly enter an approval PIN. No scheduled TikTok publication is implemented.

## Requested scopes and functionality

- `user.info.basic`: identify the creator who authorizes the account.
- `video.upload`: send video or photo carousels to TikTok inbox for manual publication.
- `video.publish` (optional, separately consented): direct posting, with fresh creator information, privacy options, branded content flags and explicit user confirmation.

Access and refresh tokens are encrypted in Cloudflare D1. Original image and video objects remain private in Cloudflare R2. For TikTok `PULL_FROM_URL`, GS Poster creates unguessable three-hour media URLs under the verified property prefix; there are no permanent public draft media URLs.

## Reviewer demonstration

1. Public About, Terms and Privacy pages; dedicated privacy contact.
2. GitHub-authenticated editor dashboard and TikTok Connect button.
3. TikTok's own Login Kit consent page with requested scopes.
4. GS Poster showing granted scopes without exposing tokens.
5. New TikTok-only draft with images and a multi-image preview.
6. URL-prefix verification: `https://gs-poster.goofyspook.workers.dev/tiktok/media/`.
7. Upload to TikTok inbox, processing status, manual publication within TikTok.
8. Optional private Direct Post test with fresh privacy options and explicit PIN confirmation.
9. Disconnect TikTok and verify local authorization is removed.

Do not display API credentials, PINs or token-bearing media links in publicly distributed recordings.

## Operator review blockers

- Confirm the TikTok developer application genuinely supports both upload and direct permissions in the intended environment.
- Verify the TikTok callback and media URL properties in the portal.
- Verify the app's product scope and public website meet TikTok's review criteria. TikTok explicitly disfavors applications restricted solely to managing one's own or internal accounts.
- Provide a reachable privacy-support contact address and review legal wording.
- Validate one real video and photo transfer and record reviewer evidence.
- TikTok may prevent public Direct Post until the app passes an audit. GS Poster currently restricts direct tests to SELF_ONLY.
- The app must not claim it performs automatic TikTok scheduling.

## Public addresses

- About: https://gs-poster.goofyspook.workers.dev/about
- Terms: https://gs-poster.goofyspook.workers.dev/terms
- Privacy: https://gs-poster.goofyspook.workers.dev/privacy
- Login callback: https://gs-poster.goofyspook.workers.dev/tiktok/callback
- Verifiable media property: https://gs-poster.goofyspook.workers.dev/tiktok/media/

See [TIKTOK_SETUP.md](./TIKTOK_SETUP.md) for current implementation steps and official API references.
