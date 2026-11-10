# PR #90 isolated staging acceptance checklist

This is a **release gate**, not a deployment authorization. Never use production OAuth credentials, Pages, media accounts, storage bindings or the production Worker hostname for staging. No code in this pull request deploys or publishes automatically.

## Isolation prerequisites

Provision a **different** Cloudflare Worker name and hostname, private R2 bucket, D1 database, and OAuth KV namespace. Make a separate Wrangler configuration with `triggers.crons=[]` and no production Facebook, Bluesky, Instagram, TikTok or other publication credentials. Do not run `scripts/prepare-deploy.mjs` with production resources, and do not point a test Worker at the production database or bucket. Record the exact Git commit, account/environment identifiers (not secrets), installed permissions, and proof that scheduled triggers and all publication paths are disabled. Use test-only sign-in with an explicit allowlisted account, never an imported production session.

## Live upload matrix

Run on Cloudflare's real Worker isolate, not solely Miniflare. Use real, non-sensitive MP4 samples that contain an `ftyp` box and whose byte lengths are **40,000,000** and **49,000,000**. Keep a local SHA-256 checksum of each source. A local 20-byte MP4 signature alone is not evidence of provider compatibility.

1. Obtain a one-time private upload grant in the staging UI for each size. Stream `PUT` with an exact `Content-Length`, then check that response bytes, owner-scoped status and R2 object size match the source. Confirm the same bearer URL cannot be reused, and that a different authenticated user cannot attach or inspect the upload.
2. Use a permitted test GitHub repository source for a saved draft. Prepare it with the signed-in linked-video action. Confirm that the source remains unchanged, the staging object's ranged 5 MiB digests and total size match the original, the stored-reference replacement is version fenced, and nothing is approved or published.
3. Attempt an invalid MP4 signature, an empty/truncated stream, a missing/oversized length declaration, and a stream larger than its accepted declaration. Confirm 4xx failures as appropriate, consumed links, no finalized object, terminal `failed` state and released storage reservation when no write or a confirmed abort occurred.
4. Force an abort error and ambiguous multipart completion (using isolated test hooks or an injected test binding, **not** production R2 fault injection). Confirm `uploading` remains non-attachable, the bearer is non-replayable, and quota reservation stays intact until reconciled. Verify a known failed readback followed by confirmed object deletion frees quota.
5. Record the R2 object size and D1 quota before/after each attempt. Confirm no repeated malformed submissions accumulate 50 MB reservations, while successful uploads reserve only actual stored bytes.

Record Cloudflare Worker memory observations, 5xx rate, error 1102 and `exceededMemory` signals for each scenario. Pass/fail is based on live observations, not on source inspection or Wrangler dry-run. Also test private 40-49 MB media consumption through the existing signed-in video preview, Bluesky/TikTok preparation paths, and Instagram manual download where applicable, without publishing anything externally.

## Facebook-specific gate

Private storage supports up to 50 MB, but the existing simple Facebook transport is explicitly capped at **20,000,000 bytes**. Test a 20,000,000-byte Facebook video and a 20,000,001-byte video. The latter must fail **before** approval, external TikTok transfer, Instagram job queue or a Facebook retry claim, leaving post status, approval timestamp and remote calls unchanged. Do not assume a larger Facebook video is supported by the private storage increase. A real provider publish test requires a separately approved nonproduction Page and credentials; it is not part of this isolated, publication-disabled environment.

## Real browser interactions

On desktop and mobile browsers, exercise source-pool click/drag copy for Bluesky, one-shot copy save, Facebook/TikTok/Bluesky reorder and keyboard arrows, new-draft drag retention of per-image destination/alt text, rejected draft return, Week current-time line/drag, Month date navigation and overflow pages, horizontal scrolling and daylight-saving transitions. Check that no GET request or drag interaction changes approval or publishing state. Capture dated screenshots or recordings and user-visible results.

## Handoff evidence

Attach the exact deployed staging commit, commands, sanitized HTTP results, sizes/checksums, Cloudflare memory/errors chart, D1 statuses and quota arithmetic, browser observations, failures, and cleanup proof to pull request #90. Independent reviewer must re-check the final source commit and evidence. A green GitHub Actions run is necessary but **not sufficient** for production approval. Keep the pull request draft until the owner and independent reviewer expressly clear all gates.
