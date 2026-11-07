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
- **Meta callbacks:** `POST /threads/deauthorize` and `/threads/delete` verify `signed_request` (HMAC-SHA256 with the app secret). They only remove the stored connection. Delete returns the `{url, confirmation_code}` that Meta requires. After the 7 November T4 correction, every valid fresh signed callback for the current account suspends its posting authority, including ambiguous early events and replays after reconnect; the owner must use PIN-gated Disconnect, then Connect and reauthorize. Event digests and the suspension marker are durable.
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
- **Media:** `/threads/media/<token>.jpg` is public by design. Tokens are hashed, expire after six hours, and match only the active frozen job generation that issued them. Instagram-sourced photos are rendered with `renderInstagram`; Facebook photos are re-encoded as JPEG at up to 1440 px.
- **PIN-gated controls:** cancel, retry before the barrier, and close an unclear result, which also needs "I checked the GS Grimoire Threads profile".
- **Lifecycle:** PIN-approved calendar moves and cancellation can move or stop a waiting Threads job. Background reconciliation of a missing Facebook post leaves Threads alone.
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

## Review round 1 (ChatGPT-2, head `8c4d83d`)

- **T1 (frozen approved Threads posts):** already fixed at `9d40304` (see the F4 section above). It now also has a production-router test: a time change, switching Threads off and reject are each refused for a Threads-only approval, and the post stays frozen while only its Instagram job is pending.
- **T2 (renewal blocking publishing):** the scheduled handler now calls `runThreadsCron`. It tries renewal first; a renewal failure goes to the audit log (`threads-renewal-failed`) and never stops `processThreadsBatch`, which uses the still-valid token. The cron run is still reported as failed afterwards. Tested: with renewal failing, a due post is processed; the next run renews and publishes.
- **Checks:** `npm run check` gave 400 passed, 0 failed, twice. The `wrangler` dry-run passes.

## Review round 2 (ChatGPT-2, head `86ad685`): T3

- **Finding:** jobs didn't record which Threads account they were approved for. After disconnecting A and connecting B, cron would publish A-approved content on B without a new approval.
- **Fix:**
  - `threads_jobs` gains `account_id` and `account_username`, both required. Approval stores the account connected at that moment; the insert is fenced on that `threads_accounts.user_id`.
  - Each cron run reads the sign-in once (`threadsAccessToken`) and uses only those credentials for every Threads call in the run, so a reconnect mid-run can't switch accounts.
  - Before any call, the run compares the connected account with `job.account_id`. On a mismatch it fails the job before sending, and not as unclear, whether the job was preparing or processing. The message names the approved account.
  - Retrying with the wrong account fails again. Reconnecting the approved account and retrying publishes.
  - A send already past the barrier keeps the existing unclear handling and is never replayed.
  - The approval checkbox and the job card name the account.
- **Tests (5 new):** A to disconnect to B before due (no Threads call at all, a retry under B still sends nothing); reconnecting A then retrying publishes once on A; an account change while the container is prepared stops before the final send; a reconnect while A's final send is in flight still sends with A's token to A's endpoint; approval records the account connected at queue time.
- **Checks:** `npm run check` gave 405 passed, 0 failed, twice. The `wrangler` dry-run passes and `git diff --check origin/main...HEAD` is clean.

## Review round 3 (ChatGPT-2, head `71e4ca6`): T4, T5 and the send-barrier fence

- **T4, signed callback replay:** `connected_at` is written with the account row and preserved by renewal. Callback deletion compares the signed issue time with the currently stored authorization in the same database statement. An event within the five-minute clock allowance of a newer sign-in cannot revoke that sign-in. That ambiguous callback is acknowledged without removing the token, even if the event was for the current sign-in.
- **T5, body size:** the callbacks no longer call `formData()`. `readBounded` reads at most 8 KB from the stream whatever `Content-Length` says, cancels the rest, and the body is parsed as Meta's form encoding. A declared oversize body is refused before reading. Empty, malformed and multipart bodies have no valid `signed_request`, so they get 400.
- **Disconnect during a run:** the irreversible `sending` transition now requires, in the same `UPDATE`, that the job's approved account is still the connected one. If the account was disconnected or switched since the run read its sign-in, the job fails before sending (not unclear). Remaining window: between that barrier commit and the `threads_publish` request itself, a disconnect doesn't stop the request. It still goes only to the approved account with that account's token, and the existing unclear-result handling applies.
- **Tests:** stale, future and timeless callbacks refused; a replay from before a reconnect leaves the new sign-in; a fresh event still revokes; renewal keeps `connected_at`; an endless streamed body with no declared size is stopped after about 8 KB without revoking anything; declared oversize and malformed bodies are refused through the router; a disconnect while a run waits on the status check stops the job at the barrier.
- **Checks:** `npm run check` gave 424 passed, 0 failed, three runs. The `wrangler` dry-run passes and `git diff --check origin/main...HEAD` is clean.


## 7 November security-review correction: fail-closed Threads callbacks (T4)

- A signed Meta deauthorization or deletion event carries a user ID and second-resolution issued timestamp, not a connection-generation identifier. Neither five-minute skew arithmetic nor same-second timestamps can safely attribute an event to an authorization generation.
- **Policy:** any valid signed event for the currently connected user ID, up to 24 hours old or 5 minutes in the future, atomically suspends the current local authorization. The Worker returns the provider-compatible response only once the database transaction completes. The `threads_accounts` suspension fields and `threads_revocation_events` digest record the event for owner reconciliation; duplicate signed events cannot restore access.
- No suspension clears automatically. Token reads, renewals, new approval, media grants, photo service and the final publish barrier refuse suspended accounts. Outstanding pre-send jobs fail without being marked unclear. Reconnect and retries require the existing owner approval PIN controls; the owner must disconnect the held account, reconnect in Meta, and explicitly retry the job.
- **Tradeoff:** a legitimate older signed callback can be replayed within the 24-hour timestamp window to suspend an otherwise freshly reconnected account. This can deny service until the owner reconnects again. Blocking such a replay without accepting a genuine early revocation is impossible with the supplied callback fields. We deliberately prefer interruption over publishing under locally revoked authority. Older than 24 hours, future beyond 5 minutes, and invalid signatures are rejected.
- **Irreversible boundary:** suspension committed before the atomic `sending` transition prevents the final send. Once a send has crossed that barrier, it may complete using the previously read token despite a concurrent suspension; an interrupted response remains unclear and is never automatically resent. This is the pre-existing final-send uncertainty boundary, not permission to publish under a held account.
- Live Meta consent, callbacks and publication are still unverified; require separate staged provider acceptance and independent full review of the exact amended head. No merge or deployment is authorized by this change.
