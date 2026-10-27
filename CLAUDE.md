# CLAUDE.md: gs-poster

The point of this repo is that Claude drafts and Gus approves. Keep it that way.

## Hard rules
- Never publish or schedule Facebook content without the account owner's GitHub sign-in and PIN approval. Small approved posts use `src/publish.ts`; approved posts with over ten images are atomically queued and posted from cron through `src/facebook-queue.ts`. The cron queue must require `approved_at`, claim jobs atomically, checkpoint uploads and never automatically resend an ambiguous final feed request.
- Bluesky can publish from the Worker scheduled handler only after the corresponding target has been approved using the same sign-in and PIN flow. The scheduled handler must atomically claim approved, due targets and may not accept requests to publish unapproved drafts. Never expose a publishing tool to any Model Context Protocol client.
- Never weaken the approval guards: allowed GitHub logins, PIN and lockout, CSRF and same-origin checks, the atomic `claimForPublish`.
- Never read, print, log or ask for secret values (Facebook token, PIN, OAuth client secret, Cloudflare token). Never commit `.dev.vars`.
- Never push to `main`. Work on a branch and open a pull request. ChatGPT reviews and merges (Gus does not review code, same as gs-scribe). Merging to `main` deploys.
- Never merge your own pull request, approve a deployment, or change `.github/workflows/deploy.yml` so that pushes to other branches deploy.
- Changes to anything above need Gus's explicit go-ahead in the conversation, described plainly before you make them.

## Working here
- `npm run check` (typecheck + tests) must pass before pushing. `npx wrangler deploy --dry-run --outdir dist` checks the bundle.
- The house rules in `src/validate.ts` mirror the gsgrimoire-release-schedule skill. If the skill's brand rules change, update both.
- Local end-to-end testing: `npm run dev` with test values in `.dev.vars`. `GRAPH_BASE_URL=http://127.0.0.1:<port>` points Facebook calls at a local mock; it is ignored for any other host.
- Deploys run from `main` via GitHub Actions, so a merged pull request goes live.

## Review checklist (for ChatGPT before merging)
1. CI is green (`npm run check` and the bundle dry-run).
2. Facebook publishing is restricted to the sign-in/PIN-approved immediate path in `src/publish.ts` and the approved-only cron queue in `src/facebook-queue.ts`. Bluesky cron can publish only atomically claimed approved targets. No Model Context Protocol tool can publish.
3. The allowed-logins check, PIN and lockout, CSRF and same-origin checks and `claimForPublish` are unchanged or stronger.
4. No secrets, tokens or `.dev.vars` in the diff.
5. PUT /upload/:id/:token is the only unauthenticated write. It must stay one-use, hash-token-gated, size-limited and magic-byte checked.
6. Files uploaded to private R2 must never be exposed publicly; only the Worker reads them.
7. UPLOAD_RETENTION_DAYS in src/upload.ts and scripts/prepare-deploy.mjs must match.
8. Scheduled Bluesky posts must have prior PIN approval and be atomically claimed before cron delivery.
9. Facebook queue ambiguity must be resolved only by a PIN-gated human action. Never retry a possibly successful final Graph post automatically.
10. Scheduled Facebook bulk posts must be at least ten minutes ahead at the final Graph send, not just at approval. Validate database migrations on existing data and bound image preflight.
If any of these fails, comment on the pull request and tell Gus instead of merging.

## Using the connector (for Claude in other sessions)
- Draft with `draft_post`, one post per call, with `label` (e.g. "Day 1 creature reveal"), `release` and `publish_at` in Copenhagen time.
- Tell Gus the drafts are waiting and give him the review link. Never say a post is published until `get_post` shows `published`.
- Rejected posts carry Gus's note in `gus_note`. Revise with `update_draft`.
