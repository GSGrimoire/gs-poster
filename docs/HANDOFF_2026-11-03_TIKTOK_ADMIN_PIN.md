# Full security review: TikTok account-administration PIN policy

Date: 3 November 2026
Implementer: ChatGPT-1 | Implementer, GitHub account `GSGrimoire`
Owner approval: [issue #73](https://github.com/GSGrimoire/gs-poster/issues/73#issuecomment-6617149647)
Review depth: **Full**. This affects account authorization, revocation, hosted TikTok verification material and the global owner approval PIN and lockout.

## Owner decision and scope

The owner explicitly approved extending GS Poster's existing approval PIN and global one-hour lockout to every TikTok account-administration action. All three current state-changing operations in `POST /tiktok/(connect|disconnect|verify)` are included. The read-only `GET /tiktok/settings` is unchanged. Connection initiation still requires signed-in GitHub owner status and the existing same-origin and per-session cross-site request forgery token.

The TikTok Login Kit callback remains a `GET /tiktok/callback` issued by the external provider. It cannot carry a plaintext PIN through a redirect. Instead, the **only production route creating its unguessable one-use authorization state** is `POST /tiktok/connect`, now PIN-gated. The state is bound to the original signed-in browser session hash, login, authorized scopes and 10-minute expiry, and the callback validates the `__Host-` cookie and deletes the saved state before attempting token exchange. A callback now additionally fails closed when the approval PIN is unconfigured or global lockout active. The callback does **not** accept a query/form PIN and does not open a separate authorization bypass.

## Entry points and trust boundaries

1. `src/web.ts::handleWeb`: GET read-only settings requires the signed-in allowlisted session, the POST route delegates to `tiktokSettingsAction` with the same session, callback delegates to `tiktokCallback`. Anonymous media URLs and ordinary GitHub login are unchanged.
2. `src/tiktok-web.ts::tiktokSettingsAction`: checks method POST, same-origin and Fetch Metadata, bounded declared request length, parses form, validates signed-session CSRF token, then checks `APPROVE_PIN` configured, `pinLocked`, and constant-time `safeEqual` against submitted PIN. Wrong PIN increments shared `pin_failures` before returning HTTP 403, with a non-sensitive wrong-pin audit. The 5th wrong PIN activates the existing shared one-hour lockout; subsequent correct PINs fail with HTTP 429.
3. `connect`: only after gate, check current TikTok account, select allowed scopes and persist the session-bound Login Kit authorization state. The generated same-origin handoff page and secure cookie never contain the PIN.
4. `verify`: only after gate, validate/host the exact text verification filename and content. Public verification filenames remain subject to the existing strict text/plain pattern, and no arbitrary file serving is added.
5. `disconnect`: only after gate and explicit confirmation, revoke the provider grant where possible and remove the encrypted connection. Existing warning when remote revocation cannot be confirmed remains.
6. `src/tiktok.ts::finishTikTokConnection`: cookie/state/session hash/actor/expiry/scope match is still required, state is deleted before exchanging a one-time code, a different account cannot silently replace an existing connection, and tokens remain encrypted. The new check prevents completing an old in-flight OAuth state while account-administration PIN enforcement is disabled or globally locked.
7. `src/db.ts::pinLocked/recordPinFailure`: unchanged global counter and one-hour window, already used by post approval and recovery. Failing TikTok PIN attempts contribute to that same global counter. TikTok settings have no separate unlimited retry budget.

No changes to Facebook or Bluesky publication, TikTok post transfer consent/PIN, approval queue, upload tokens, other OAuth client authorization, stored encryption keys, direct-post visibility, or public media.

## Failure and state transition matrix

| Condition | Result |
| --- | --- |
| Expired/missing/revoked allowlisted browser session | No admin action; signed-out redirect or callback denied |
| Cross-origin request, wrong Fetch Metadata, absent/invalid form CSRF | HTTP 403 before any PIN attempt, account change or external request |
| Missing configured `APPROVE_PIN` | HTTP 503; admin actions and callback refuse |
| Invalid, absent or wrong PIN | HTTP 403; shared failure counter increases; no state/verification/account change |
| Five wrong PINs within one hour | Shared lockout: HTTP 429 on subsequent admin requests and callback, even with valid PIN |
| Correct PIN and no current TikTok account | Connect issues short-lived Login Kit state only, not a connected account |
| Callback missing state, wrong cookie/session, expired or replayed state | No token exchange, account unchanged |
| Callback authorized state, provider denies or code invalid | State consumed and no account change |
| Callback authorized state, legitimate matching token response | Token encrypted and stored; existing identity/scope protections remain |
| Correct PIN verification | Validated text file saved, audit attempted; no content is published |
| Correct PIN disconnect with explicit confirmation | Current account removed after remote revocation attempt, including existing revocation-warning behavior |
| Successful PIN plus absent disconnect confirmation | Refused before revocation; record unchanged |
| Audit recording error after wrong PIN | Failure counter still records; wrong PIN is never printed/logged |

## Adversarial validation

`test/tiktok-admin-pin.test.ts` executes the actual `handleWeb` in isolated Miniflare/workerd with test-only credentials. Regression coverage includes each action with missing/wrong PIN, cross-site and CSRF failures, forged/revoked session, no side effects before authorization, correct PIN verification/connect and no-account disconnect, UI password fields, disconnected account preservation on wrong PIN, one-use callback state cancellation/replay, global five-failure lockout including callback, and missing approval PIN fail closed.

Reviewer should independently assess all changed code plus unchanged sibling actions: account switching, token refresh/leases, the Login Kit callback and secure cookie, `isSameOrigin`, session/CSRF checks, the shared PIN failure counter and publishing gates. Tests with a mock provider cannot prove live TikTok account acceptance. The owner's later live-site quality assurance will verify the real browser callback and verified public file path.

## Merge gate

Full independent security review at the **final exact pinned commit**, green `npm run check`, green `npx wrangler deploy --dry-run --outdir dist`, and approval by an independent qualified session. This implementer does not approve, merge or deploy. Production changes occur only after authorized merge and protected deployment.
