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

## Executable acceptance infrastructure added to PR #90

The code on this branch now includes a headless **real Chromium** desktop/mobile acceptance test that runs automatically in a separate GitHub Actions job, `.github/workflows/pr90-browser-acceptance.yml`. It uses the real bundled application and an isolated Miniflare database, not a screenshot mock. The job uploads `results.json` and individual browser screenshots as an Actions artifact. This is **not** a Cloudflare production-isolate test, and green browser checks do not constitute final release approval.

### Provision the separate Cloudflare environment first

Set up the GitHub Actions **environment** `pr90-isolated-staging` with required manual reviewers. Create separate resources with a `gs-poster-pr90-` prefix, never reuse the live application's bucket, database, OAuth namespace, hostname or GitHub OAuth client. Set these environment variables:

| Environment variables | Purpose |
| --- | --- |
| `PR90_WORKER_NAME` | Distinct `gs-poster-pr90-...` Worker |
| `PR90_R2_BUCKET` | Distinct `gs-poster-pr90-...` private bucket |
| `PR90_LOGIN` | Test-only allowlisted GitHub account |
| `PR90_STAGING_ORIGIN` | HTTPS `https://<PR90_WORKER_NAME>.<subdomain>.workers.dev` origin |

Set these **staging-only environment secrets**: `PR90_D1_DATABASE_ID`, `PR90_KV_NAMESPACE_ID`, `PR90_CLOUDFLARE_ACCOUNT_ID`, `PR90_CLOUDFLARE_API_TOKEN`, `PR90_STAGING_COOKIE_SECRET`, `PR90_STAGING_GITHUB_CLIENT_ID`, `PR90_STAGING_GITHUB_CLIENT_SECRET`. Configure the separate GitHub OAuth app callback URL under this staged origin. Use an API token restricted to those staging resources. Do not put production values into any of these slots.

The staging deployment workflow **does not run on commits**. To stage *before the PR is merged*, have an authorized owner add the label `pr90-staging-acceptance` to pull request #90. The `pull_request:labeled` workflow checks the PR number, same-repository source, exact branch, and isolated environment. The environment reviewers should inspect the proposed exact head before approving the workflow execution. The `workflow_dispatch` alternative is usable only when the workflow is also available on the default branch; do not merge solely to enable it. No staging execution has been performed by the implementer.

The generated Worker configuration selects `src/pr90-staging-entry.ts` instead of the production entry, has no cron triggers, no production provider secrets, and rejects publishing, retry, external integration and approval endpoints even with credentials. The staging public probe checks this boundary and produces a JSON artifact. If a probe fails, do not continue with acceptance.

### Stream real video through the staged Worker

Prepare real MP4 files of **exactly 40,000,000 and 49,000,000 bytes**, retain the original checksums and use separate one-use upload grants obtained from the *staged* UI. While each grant remains valid, run locally, keeping secret grants out of shell history and CI logs:

```bash
export PR90_STAGING_ORIGIN="https://gs-poster-pr90-acceptance.<subdomain>.workers.dev"
# Set PR90_UPLOAD_URL securely to a freshly issued staged grant.
node scripts/pr90-staging-upload.mjs /path/to/real-40000000.mp4
node scripts/pr90-staging-upload.mjs /path/to/real-49000000.mp4
```

The operator must supply a **different fresh grant** before each command. The script streams bytes from disk with an explicit Content-Length, checks returned stored size, requires replay refusal and writes sanitized checksum/status evidence to `artifacts/pr90-staging`. It cannot itself confirm remote R2 bytes or Cloudflare memory telemetry.

For the **GitHub allowlisted import**, create a separate unapproved staging draft with a video URL in the repository allowed by the application. Use a **staging-only** signed-in browser session cookie, supplied through the private `PR90_SESSION_COOKIE` environment variable, and run:

```bash
node scripts/pr90-staging-private-video.mjs p_STAGINGDRAFTID tiktok /path/to/real-40000000.mp4
```

Repeat with a new staging draft and the 49,000,000-byte source. The importer pulls the saved URL in the draft, uses the browser's CSRF/version fence, and requests **no approval or publication**. The script checks a 1-megabyte signed-in range read and a full downstream preview checksum against the input, and writes sanitized evidence. Avoid sharing or uploading staging cookies to GitHub.

### Complete the nonautomated evidence

For both sizes and both import methods, independently inspect the staged R2 object's size/digest and D1 upload rows and quota, including malformed, uncertain and replay scenarios. Capture Cloudflare Worker 5xx, error 1102 and exceededMemory metrics across the test period, along with staged preview/download behavior. Attach dated screenshots, real-browser artifact results and failures, the staging commit identifier, cleanup proof, and the operator's recording of resource isolation to PR #90. If instrumentation is missing, the gate remains blocked. The separate reviewer must inspect this evidence at the latest exact PR head before production merge.
