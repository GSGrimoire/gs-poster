# GS Poster handoff: Threads connection and approved publishing (5 November 2026)

**Session:** Claude-1 | Implementer. **Built on:** the Instagram pull request (#83), because both change the same approval, editor and cron code. Merge #83 first.
**Review depth:** Full. This adds an OAuth connection, an encrypted token, public callbacks, a public media route and a publishing path.
**Owner go-ahead:** Gus approved this plan and the matching hard rule in the Claude session on 5 November 2026.

## What it does

- **Settings** (`/threads/settings`, linked from the planner): Connect and Disconnect. Both need same-origin, CSRF and the approval PIN with the shared lockout, the same gates as TikTok account administration.
  - Connect stores a random state as a hash, bound to the session and a `__Host-` cookie, single use, for 10 minutes. It then navigates to `threads.net/oauth/authorize` with `threads_basic,threads_content_publish`.
- **Callback** (`/threads/callback`) needs the signed-in session. It refuses while the PIN is unset or locked, and consumes the state once. It exchanges the code (dropping Threads' trailing `#_`), then gets the 60-day token, then reads `/me`. Only one account is allowed; a different one is refused.
  - The token is stored only AES-GCM-encrypted. The key comes from HKDF over `COOKIE_SECRET`, with its own context string and additional authenticated data. Rotating `COOKIE_SECRET` means reconnecting Threads.
- **Renewal:** cron renews the token under a lease once it is a day old and has less than 14 days left.
- **Meta callbacks:** `POST /threads/deauthorize` and `/threads/delete` verify `signed_request` (HMAC-SHA256 with the app secret). They only remove the stored connection. Delete returns the `{url, confirmation_code}` that Meta requires.
- **Editor:** a Threads chip and card. The text is up to 500 characters. Photos are text only, the Instagram card's framed photos, or the Facebook photos (up to 20). It is saved in the same fenced transaction as the rest of the draft. The MCP `update_draft` tool gains an optional `threads` field, still prepare-only.
- **Approval:** a Threads checkbox and consent tick, offered only while connected. The plan checks the text length, the house rules and the photo count, and refuses an Instagram Reel. Approval freezes the text and the exact photos (with Instagram crop or pad settings) into `threads_jobs`. Nothing is sent during approval.
- **Cron publishing** (`processThreadsBatch`) is the same state machine as Instagram:
  - lease claim;
  - up to five carousel children per run, each checkpointed;
  - the parent container (`TEXT`, `IMAGE` or `CAROUSEL`);
  - a `status` poll until `FINISHED`;
  - the one-way `sending` barrier;
  - `threads_publish` once.
  - An unclear result is never resent. A deleted draft cancels its unsent job. A disconnected account fails before anything is sent.
- **Media:** `/threads/media/<token>.jpg` is public by design. Tokens are hashed, expire after six hours and only work while the job is active. Instagram-sourced photos are rendered with `renderInstagram`; Facebook photos are re-encoded as JPEG at up to 1440 px.
- **PIN-gated controls:** cancel, retry before the barrier, and close an unclear result, which also needs "I checked the GS Grimoire Threads profile".
- **Lifecycle:** the calendar move, cancelling a scheduled post and Facebook removal all move or stop a waiting Threads job.
- **Check:** `check_setup` reports `threads: { ok, username, expires_at | error }`.

## Tests

`test/threads.test.ts` (10 tests) covers:
- encryption at rest, and the wrong key failing;
- state stored hashed, bound to browser and session, used once;
- the code clean-up;
- the token encrypted in D1;
- a second account refused;
- renewal timing and lease;
- forged and valid `signed_request`, and the delete response;
- plan checks for not connected, length, Reel and house rules;
- a text post and an Instagram-framed carousel, each published once;
- the token sent only to `graph.threads.net`, with redirects never followed;
- an unclear send never resent;
- disconnect before sending;
- media links only while active.

`test/threads-route.test.ts` (5 tests, the production router in workerd) covers:
- connect refused for a wrong or missing PIN, cross-site requests and forged CSRF, with no state created;
- a successful connect setting the `__Host-` cookie;
- the callback needing a session and respecting the lockout;
- unsigned account callbacks refused;
- the editor card, and saving with length and media validation;
- job controls needing the PIN and the tick.

`npm run check`: 392 passed, 0 failed, twice (with #83's tests included). The `wrangler` dry-run passes and `git diff --check` is clean.

## Not verified

There has been no real Threads app, sign-in or post. Untested so far: Meta's real consent screen, token lengths and `expires_in`, Meta fetching the JPEGs, and real container processing times. Gus covers these in the Archive Arena Threads stage, steps 2 to 8.

## For the reviewer

- Check that nothing but the PIN-gated approval inserts into `threads_jobs`, and nothing but cron calls `threads_publish`.
- Check that the token never reaches HTML, logs, MCP output or errors. Error text includes only Meta's message, capped at 300 characters.
- Check that `signed_request` handling cannot be used to do anything except delete the stored connection.
- Key derivation from `COOKIE_SECRET` is a deliberate choice, so Gus needs no extra secret. Say if you'd rather have a dedicated `THREADS_TOKEN_ENCRYPTION_KEY`.

## #83 review round 1, applied to Threads

The three Instagram findings apply equally here and are fixed the same way:
- `deletePost` refuses any post with a Threads job that isn't cancelled.
- `updateCalendarTime` moves a waiting `threads_jobs.due_at` in the same batch and refuses once Threads has started.
- The final send has its own ten-minute lease; an expired one becomes unclear and owner-only.
- A late answer records the post only while the owner hasn't decided.
- A failed media-id write keeps the id in the error.

Tests are in `test/threads.test.ts` (5 more) and a successful text-post approval through the production router is in `test/threads-route.test.ts`.

## #83 review round 2 (F4), applied to Threads

While a Threads job may still publish or is unclear:
- `saveEditorDraft` refuses a time change or switching Threads off, inside the posts `UPDATE`;
- `rejectDraft` refuses to reject the post;
- the web save, MCP `update_draft` and reject paths return a plain reason first;
- the Threads card says the approved post is frozen.

A cancelled or published job unlocks the draft. Tested in `test/threads.test.ts` (database guard, MCP refusals, a text edit still saves with the job frozen, reject works after the PIN cancel). `npm run check`: 398 passed, 0 failed, twice.
