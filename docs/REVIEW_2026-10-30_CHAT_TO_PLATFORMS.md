# GS Poster full review: chat media to every platform

**Date:** 30 October 2026, evening
**Session:** Claude-1 | Reviewer (Claude, owner-requested). Read-only review plus documentation. **Mini review** for this change: docs only, no source, auth, storage or publishing code touched.
**Reviewed head:** `main` at `082cf7b` (merge of native ChatGPT intake, PR #44), deployed by Deploy run on 30 Oct 20:12 UTC, live smoke passed.
**Owner goal:** content made in a chat (images from ChatGPT and Claude, video, text) goes into a GS Poster draft, then out to each platform in that platform's own form and within its limits, with Gus approving.

## Evidence gathered

- Cloned `main`, read `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md`, the 30 Oct handoff, every doc in `docs/`, and the intake, upload, publish, queue, TikTok and Bluesky sources.
- `npm ci`, `npm run check`: typecheck clean, **154 of 154 tests pass**. `wrangler deploy --dry-run`: bundle builds.
- Connected GS Poster (read-only calls only): `check_setup`, `list_posts`, `get_post`, `list_page_posts` for both published and scheduled.
- `npm audit` and a source-map check of the built bundle.
- Network probe from a Claude cloud session to the Worker (see finding 3).

Nothing was approved, uploaded, published or edited in GS Poster.

## Bottom line

The intake half is in good shape and now genuinely reaches chat content: ChatGPT attachments go straight in through `import_chatgpt_files` (deployed tonight, not yet live-tested), and any client can fall back to the private browser upload page. Per-platform composition (separate captions, separate galleries, per-platform caps, WebP conversion for TikTok and Bluesky) is well designed.

The **release** half has one serious production fault that should be fixed before any new feature work: approvals of normal image posts can silently die mid-request and leave the post stuck in `publishing` forever, with no recovery path in the UI. **Seven approved posts are stuck right now and none of them reached Facebook**, which has also broken the Bare vs GS carousel A/B test.

## Findings, in priority order

### P0-1. Seven approved Facebook posts are stuck in `publishing` and never posted (issue #49)

Live state on 30 Oct (GS Poster record vs Facebook's own published and scheduled lists):

| GS Poster post | Planned time | GS Poster status | On Facebook |
| --- | --- | --- | --- |
| Week 1 Tue, Bare: campaign openings | Tue 27 Oct 19:00 | publishing, no Facebook id, no error | **Missing** (slot passed) |
| Week 1 Thu, Bare: shopkeeper lines | Thu 29 Oct 19:00 | publishing | **Missing** (slot passed) |
| Week 2 Tue, GS: campaign openings | Tue 3 Nov 19:00 | publishing | Not on Facebook's schedule |
| Week 2 Wed, GS: death save rules | Wed 4 Nov 19:00 | publishing | Not on Facebook's schedule |
| Week 2 Thu, GS: shopkeeper lines | Thu 5 Nov 19:00 | publishing | Not on Facebook's schedule |
| Wed, GS: CR 3 creatures that end careers | Wed 11 Nov 19:00 | publishing | Not on Facebook's schedule |
| Thu, Bare: CR 4 creatures nobody uses | Thu 19 Nov 19:00 | publishing | Not on Facebook's schedule |

All seven are 7-slide image carousels, approved within about 45 minutes on 26 Oct. In the same batch, Week 1 Wed Bare, CR 3 Bare and CR 4 GS went through normally, so the failure is intermittent.

**Most likely cause.** `approveAndPublish` in `src/publish.ts` claims the post (`draft` to `publishing`), then, still inside the browser's approval request, downloads each image from GitHub raw and uploads it to Facebook one by one before creating the feed post. Only posts with **more than ten** images go through the durable cron queue (`BULK_FACEBOOK_THRESHOLD = 10`). A seven-slide carousel is several megabytes of downloads and uploads inside one request. If that request is cut off (the browser leaves the page, a phone locks, the Worker hits a limit), nothing after the claim runs: no Facebook id, no error, no final status. The page has recovery controls for queue jobs and for `failed` posts, but **none for a `publishing` post with no queue job**, so these records can never move again without a database edit.

**Fix direction (Full review: publishing path).**
1. Send **every** Facebook media post through the durable queue, not just posts over ten images. The queue already checkpoints each upload and has a one-way `sending` barrier against duplicate feed posts. Text-only posts can keep the direct path.
2. Add a PIN-gated "stuck publishing" reconciliation on the review page for a `publishing` post with no Facebook id and no queue job, older than a few minutes: Gus confirms in Meta that nothing went out, and the post returns to `failed`, from where the existing retry or back-to-draft paths apply.
3. Regression tests that simulate the request dying after the claim, for 1, 7 and 11 images.

**What Gus should do now (no code needed):** these posts are not on Facebook. Until the fix lands they cannot be re-approved from GS Poster. The two past-dated ones missed their slots; the five future-dated ones will not go out unless redrafted. For the A/B test, only Week 1 Wed (Bare) actually ran, so neither week has comparable data yet.

### P1-2. Posts can be approved with no media when the draft says media is pending (added to issue #48)

Two published posts went out with **zero images** in GS Poster although their labels said otherwise: "The Black Kiln launch teaser (images pending)" and "10 player habits carousel: 7 slides to attach". The approval page warns about a missing Patreon link, but not about a post that is plainly waiting for media.

**Fix direction (Mini review if limited to warnings and an extra confirmation checkbox).** On approve, if the Facebook target has no image and no video **and** the label or release contains `pending`, `HOLD`, `attach` or `to attach`, refuse unless Gus ticks "Publish without media". Same for Bluesky. This sits naturally in the pre-publish check panel proposed in issue #48.

### P1-3. Claude sessions have no working automatic intake path (issue #50)

- A Claude cloud session (claude.ai with code tools, which is where Claude builds carousels and reels) **cannot reach the Worker**: an outbound request to `gs-poster.goofyspook.workers.dev` is refused by the session's network allowlist (`CONNECT tunnel failed, 403`). So "PUT the bytes to `upload_url`", which `CHAT_MEDIA_WORKFLOW.md` path A describes, does not work from Claude.
- Claude can, however, write to GitHub repositories attached to the session, using `gh api` from the shell. That means Claude can create a blob from the **real file bytes on disk** (base64 done by the shell, never typed by the model) in the private staging repo, then call `import_github_blob`. This is the GitHub blob bridge, and it fits Claude far better than ChatGPT. `check_setup` reports the staging repo as configured and private.
- In practice Claude-made carousels currently go in by committing PNGs to the **public** image library (`GSImageLibrary/social/...`) and drafting with raw URLs. That works and those images are meant to be public anyway, but it exposes slides before release and grows the public repo.

**Fix direction (docs plus one owner setting, no code):** add a "Claude cloud session" route to `CHAT_MEDIA_WORKFLOW.md`: attach the private staging repo, create blobs with `gh api repos/<staging>/git/blobs` from the file on disk, compute SHA-256 in the shell, call `import_github_blob` with `expected_sha256`, then `check_uploads`. Needs the staging repo's name recorded somewhere Claude can read it (it is a Worker secret, deliberately not in source). Keep the public image library route for already-public art only.

### P1-4. Native ChatGPT intake is deployed but unproven

`import_chatgpt_files` went live tonight (PR #44 merged and deployed, and the tool is now visible to connected clients). The handoff and `BACKLOG.md` still say it is unmerged; that is out of date. The live acceptance list in `docs/NATIVE_CHATGPT_FILEPARAMS_2026-10-30.md` has not been run. The winter cave release (#46) is the natural first real test: four PNGs already hashed, draft `p_mvve6u15758e2a8340` waiting. Do not close #32 until that run succeeds.

### P2-5. TikTok has never carried a real post

No post in the last fifteen has `tiktok_enabled`. The inbox and private Direct Post code is careful, but `TIKTOK_APP_REVIEW.md` lists open blockers, including TikTok's dislike of apps that only manage the owner's own account. Treat TikTok as **manual-finish via inbox** until one real carousel and one real video have gone through. First test: a 7-slide PNG carousel (exercises the WebP conversion and URL-prefix verification).

### P2-6. Dependency audit (#13) is low runtime risk

`npm audit --omit=dev` reports 3 findings (body-parser high, fast-uri and qs moderate). All three arrive through `agents` → `@modelcontextprotocol/sdk` → `express`/`ajv`. The built Worker's source map contains **none** of these modules, so they are not in the deployed code. Recommend: classify #13 as not reachable at runtime, then bump `agents` when a release pulls fixed versions. Do not use `npm audit fix --force`.

### P3-7. Old Bluesky failure is already fixed

The Black Kiln Bluesky target failed with "Invalid record key". The current record-key code produces valid keys for every post ID checked, including that one (the published Bluesky posts carry exactly the keys the code computes), so the bug predates the current code. That target can be retried with the existing PIN-gated "Retry Bluesky" button if Gus still wants it.

## Platform matrix as implemented today

| | Facebook Page | Bluesky | TikTok |
| --- | --- | --- | --- |
| Images | Up to 80; over 10 queued by cron in batches of 8 | Up to 4, alt text required, recompressed to WebP under 2 MB | Up to 35, converted to WebP |
| Video | One MP4 up to 20 MB, not mixed with images | One MP4 up to 20 MB (GS Poster's own cap) | One MP4 up to 20 MB |
| Caption | 63,206 characters | 300 graphemes, own caption | 4,000 (photos) / 2,200 (video), own caption; photo title 90 |
| Link | Preview only when no media | Free Patreon link card, posted as a reply when there is media | None |
| Schedule | Facebook native scheduling, 10 min to 30 days | Worker cron after approval | **No scheduling**: separate PIN action, inbox or private Direct Post |
| Live evidence | Yes, but see P0-1 | Yes (images and video published 28 Oct) | **None yet** |

Not supported: YouTube, Instagram (manual Reddit and Facebook Groups queues are planned in #34 and #35). The YouTube Data API does allow uploads with the owner's own login, which makes it the most realistic next platform, especially for Free Song Sunday.

## Recommended order of work

1. **P0-1** stuck publishing: queue every Facebook media post, add the PIN-gated reconciliation, tests. Full review. Then Gus redrafts the stuck posts.
2. **P1-4** live acceptance of native ChatGPT intake, using the winter cave release (#46). Closes the ChatGPT half of the goal.
3. **P1-3** Claude route through the staging blob bridge, documented and tested once with a real carousel. Closes the Claude half.
4. **P1-2** no-media guard, folded into the pre-publish check panel (#48).
5. **P2-5** one real TikTok carousel and one video through the inbox.
6. #33 one-page multi-upload and per-platform reordering, then YouTube as the next target.
7. #13 reclassify, #5 analytics windows, #34 and #35 manual queues as capacity allows.

## Corrections to existing records

- `BACKLOG.md` and `docs/HANDOFF_2026-10-30_POSTER_PIPELINE.md` say PR #44 is unmerged and `import_chatgpt_files` is not exposed. Both are out of date as of `082cf7b`; `BACKLOG.md` is updated in this change.
