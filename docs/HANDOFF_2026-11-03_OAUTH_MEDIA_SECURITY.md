# GS Poster Full security review: OAuth consent and media redirects

Date: 3 November 2026
Implementer: ChatGPT-1 (GitHub account GSGrimoire)
Pull request: #78
Issues: #71 and #72
Review depth: **Full**. An independent reviewer must inspect the complete affected trust paths and approve an exact pinned commit before merge and production deployment.

## Entry points and security model

1. `GET /authorize` runs after `readSession` validates the signed GitHub user session and the current allowlist. `parseAuthRequest` / `describeConsent` obtain the OAuth client's request and display the requested scopes, client identity and redirect destination. `beginConsent` issues the provider's ten-minute, single-use browser-bound handle with a secure `__Host-` cookie and anti-framing headers. The new form also contains a session-specific antiforgery token produced by `csrfToken`.
2. `POST /authorize` (both Approve and Deny) now requires the same current GitHub user session, same-origin Fetch Metadata/origin validation and the session-specific antiforgery token **before** calling `approveConsent` or `denyConsent`. The OAuth provider then independently validates the browser-bound handle and consumes it before returning the OAuth result. No client-provided name or redirect URI overrides the provider's saved request. A forged request cannot create a grant without those gates.
3. `src/media.ts::fetchImage` accepts only a private upload reference or parsed HTTPS GitHub file reference. Public image fetches construct a fixed `raw.githubusercontent.com` destination. Private fallback uses a fixed `api.github.com` destination and supplies `GITHUB_READ_TOKEN` only to that host. Both requests now pass `redirect:"manual"` so a 30x is treated as a failed request and never followed by the Worker with credentials.
4. `src/video.ts::fetchVideo` already enforced manual redirects after pull request #77. `src/tiktok-import.ts`, `src/video-import.ts`, private media previews and downstream publication consumers still use the established bounded fetches, upload ownership and explicit approval paths.

## Threat model and invariants

- Untrusted external OAuth clients can ask for consent but cannot approve on behalf of an owner without the current signed-in session and form token. Cross-origin requests (including `Origin:null` where `Sec-Fetch-Site` is cross-site) fail before provider actions.
- Browsers with `Referrer-Policy:no-referrer` may legitimately send `Origin:null` on same-origin forms; the existing origin helper accepts that only alongside `Sec-Fetch-Site:same-origin`. Missing Origin/Fetch Metadata still relies on the signed-session antiforgery token and provider's bound consent cookie.
- Signed-in sessions are checked against the live `ALLOWED_GITHUB_LOGINS` allowlist on every request.
- Only `api.github.com` receives the GitHub read token, never arbitrary 3xx destinations. Public raw hosts do not receive the read token.
- Server-side byte limits and signatures remain in place. Failure to fetch causes no source mutation, upload or publisher approval.
- Approval PIN, publication authorization, queue transaction recovery and Model Context Protocol publishing permissions are unchanged.

## State and failure behavior

| Scenario | Expected result |
| --- | --- |
| Missing, expired or revoked GitHub session on consent POST | Consent denied before provider action |
| Foreign Origin or cross-site Fetch Metadata | HTTP 403 before provider action |
| Wrong or absent session CSRF token | HTTP 403 before provider action |
| Missing, replayed, expired or unbound OAuth handle | Provider denies; no grant created |
| Valid consent Approve | Provider consumes handle and completes the original request |
| Valid consent Deny | Provider consumes handle and redirects error without creating a grant |
| Public raw GitHub 30x | No following of Location; optional fixed-host token fallback only |
| Authenticated GitHub API 30x | Error, never follow Location with authorization |
| Missing body, invalid content, misleading content-length | Existing bounded stream and file validation reject |
| Legitimate private GitHub 30x | Intentionally refused, pending owner real-file QA; never silently redirect credentials |

## Tests and review focus

`test/oauth-consent-security.test.ts` bundles the actual `handleWeb` route inside Miniflare with an isolated test-only provider double. It exercises approved and denied requests, session anti-forgery validation, cross-site requests, null Origin combinations, signed-out user, fake provider binding and replay of a single-use handle. The real provider implementation is not replaced in production; this mock cannot by itself establish that the provider's internal cookies and transactions are safe. Independent review must inspect the installed provider's version and actual guarantees.

`test/github-image-redirect.test.ts` stubs public/private fetches to assert strict GitHub hosts, authorization header isolation, manual redirects, no request to a hostile redirect target, and a hard 10 MB stream bound. Existing `test/video-import.test.ts` covers the analogous GitHub video redirects and ownership controls.

The reviewer should inspect `src/web.ts`, `src/session.ts`, `src/origin.ts`, `src/env.ts`, `src/media.ts`, `src/video.ts`, `src/upload.ts`, OAuth grant completion and resource-server routing, source validation in callers, and all unchanged publish gates. This change contains no secrets, raw user files or live OAuth tokens.

Before merging: green `npm run check`, successful Wrangler dry run, independent **Approved without changes** disposition pinned to the exact new head. Live private-repo GitHub downloads, browser redirects, OAuth client compatibility, Cloudflare Worker deployment and external-provider acceptance are separate owner QA items.
