# CLAUDE.md: gs-poster

The point of this repo is that Claude drafts and Gus approves. Keep it that way.

## Hard rules
- Never add an MCP tool, route or code path that publishes, schedules or cancels a Facebook post without Gus's approval on the approval site (GitHub sign-in + PIN). `src/publish.ts` is called only from `src/web.ts` after the PIN check.
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
2. Nothing publishes, schedules or cancels a Facebook post except `src/publish.ts`, reached only from `src/web.ts` after the GitHub sign-in and PIN check. No new MCP tool can publish.
3. The allowed-logins check, PIN and lockout, CSRF and same-origin checks and `claimForPublish` are unchanged or stronger.
4. No secrets, tokens or `.dev.vars` in the diff.
5. PUT /upload/:id/:token is the only unauthenticated write. It must remain single-use, token-hash-gated, size-limited and magic-byte checked.
6. Private uploads must never be exposed as public files; only the Worker reads R2.
7. UPLOAD_RETENTION_DAYS in src/upload.ts must equal the retention configured in scripts/prepare-deploy.mjs.
If any of these fails, comment on the pull request and tell Gus instead of merging.

## Using the connector (for Claude in other sessions)
- Draft with `draft_post`, one post per call, with `label` (e.g. "Day 1 creature reveal"), `release` and `publish_at` in Copenhagen time.
- Tell Gus the drafts are waiting and give him the review link. Never say a post is published until `get_post` shows `published`.
- Rejected posts carry Gus's note in `gus_note`. Revise with `update_draft`.
