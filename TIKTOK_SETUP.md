# TikTok app review and GS Poster integration checklist

Status: Preparatory public URLs implemented. **TikTok sign-in, posting, account permissions and public media transfer are not yet enabled.**

## Public pages

- Terms of Service: https://gs-poster.goofyspook.workers.dev/terms
- Privacy Policy: https://gs-poster.goofyspook.workers.dev/privacy
- Public product description: https://gs-poster.goofyspook.workers.dev/about
- Reserved TikTok Login Kit redirect URI: https://gs-poster.goofyspook.workers.dev/tiktok/callback

These pages are readable without editor sign-in. The callback returns a normal informational response for a bare visit but **fails closed** if TikTok sends authorization parameters. It does not issue or store tokens yet.

**Before formal app review:** The GS Grimoire operator should verify the legal wording, identify a usable private privacy-support contact address, and determine an official public website that meets TikTok's requirement for a developed website. TikTok says its reviewed apps cannot be restricted to private/personal use. The current GS Poster dashboard is restricted to authorized editors, so approval may require additional product scope and explanation. Do not imply reviewer approval merely because the legal URLs load.

## Developer-side tasks

1. Register or edit the TikTok developer app. Enable Login Kit and configure web callback as the exact HTTPS URI above. No query parameters or fragment.
2. Add the Content Posting API product and request only the needed posting scopes. Use TikTok's developer dashboard to identify which scopes require approval.
3. Verify URL ownership for the app's website, Terms and Privacy locations. Configure domain or URL-prefix verification for the future public image source.
4. Implement the real OAuth flow before initiating login. Generate and verify cryptographic state, securely exchange authorization codes using the server-side client secret, handle token refresh/expiry and revoke/disconnect support. Never echo tokens on public pages.
5. For TikTok photo carousels, TikTok requires publicly fetchable HTTPS photo URLs with verified ownership under PULL_FROM_URL, without redirects, available for at least the transfer period. Do **not** expose private draft objects directly. Create a controlled public media delivery route that is enabled only after the authorized editor approves the post, with short-lived unguessable references, strict content types, expiry and a no-redirect response. Verification details and token handling must be finished before activation.
6. For TikTok videos, use a supported Content Posting API upload option after checking current platform requirements; a verified public video URL is not the only method. Media upload and publishing permissions are distinct. Respect TikTok creator privacy choices and app review restrictions.
7. Add TikTok as a third target to the post model and approval UI only after authenticated account connectivity. Separate TikTok's status, retry and audit from Facebook/Bluesky. Existing posts should remain unchanged.

## Source documentation

- https://developers.tiktok.com/docs/en/login-kit-web
- https://developers.tiktok.com/docs/en/app-review-guidelines
- https://developers.tiktok.com/docs/en/getting-started-create-an-app
- https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- https://developers.tiktok.com/docs/en/content-posting-api-reference-photo-post

No production credentials, tokens or private media should be committed to GitHub.
