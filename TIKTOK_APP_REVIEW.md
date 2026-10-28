# TikTok app review submission draft (upload-to-inbox phase)

**Status:** Prepared for operator review. Do not submit until a real TikTok connection and video transfer have been demonstrated.

## Product description (paste into the TikTok portal)

GS Poster is a web-based editorial calendar and content preparation system for GS Grimoire, a tabletop roleplaying game content project. Authorized editors prepare posts and attach short videos for social media distribution. The integration uses TikTok Login Kit for authorization and TikTok's Content Posting API to upload an MP4 video to the account holder's TikTok inbox as a draft. The creator receives a TikTok inbox notification, reviews or edits the video in the TikTok app, and decides whether to publish it. GS Poster cannot publish TikTok videos directly in this first version and never sends a video automatically from the calendar.

## Permissions requested

- `user.info.basic`: authorize the editor's TikTok account and identify the connected account.
- `video.upload`: upload the editor-selected video to the TikTok inbox for further editing and manual publication.

**Not requesting:** `video.publish`. Direct publication will be requested in a separate application update after the initial integration is validated.

## Consent and user control

1. The editor signs in to GS Poster with their authorized GitHub account.
2. The editor opens TikTok settings and explicitly chooses Connect TikTok.
3. The editor completes TikTok's Login Kit authorization and consents to the requested scopes.
4. The editor creates a TikTok video draft or chooses an existing video post and attaches a private MP4.
5. After reviewing the video, the editor selects **Send video to TikTok inbox**, confirms that final publication is manual, and enters their approval PIN.
6. GS Poster uploads the video directly to TikTok using `FILE_UPLOAD`. It records an upload identifier and allows the editor to refresh the TikTok processing status.
7. The editor opens TikTok, edits the content, chooses visibility and publishes it. At any time the editor can disconnect TikTok from GS Poster settings.

## Demonstration recording checklist

Record one test showing the following in order, without showing any access tokens, secrets or credentials:

1. Public GS Poster About, Terms and Privacy pages.
2. TikTok Connect button and TikTok consent screen, with only `user.info.basic` and `video.upload`.
3. GS Poster showing the connected TikTok account and granted permissions.
4. New draft page selecting **TikTok (send to inbox)**, uploading a sample MP4, and previewing the video.
5. Post review page requesting the approval PIN and confirming manual TikTok publication.
6. Transfer state and refreshed TikTok processing status.
7. TikTok app inbox notification, video editor and final manual Publish action.
8. GS Poster Disconnect TikTok control.

## Public URLs

- Website: https://gs-poster.goofyspook.workers.dev/about
- Terms: https://gs-poster.goofyspook.workers.dev/terms
- Privacy: https://gs-poster.goofyspook.workers.dev/privacy
- Login Kit callback: https://gs-poster.goofyspook.workers.dev/tiktok/callback

## Operator blockers before app submission

- Add TikTok Login Kit and Content Posting API in the TikTok developer portal.
- Configure the exact callback URL and obtain the client key and secret.
- Save the client key, client secret, and a separate randomly generated encryption key as Cloudflare Worker secrets.
- Confirm TikTok has granted the test user and app access to `video.upload`.
- Review the public policy text and add a working privacy-support contact method.
- Confirm the public GS Poster website meets TikTok's application review requirements for real end-user utility.
- Complete one live authenticated upload to verify TikTok accepts the current configuration.
- Capture the demonstration recording and any required screenshots.
- Submit the application for approval under `video.upload`. Do not claim that it already supports direct posting or automatic TikTok scheduling.

This file contains no secrets and is suitable for use as a reviewer instruction sheet.
