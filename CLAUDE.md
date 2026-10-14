# CLAUDE.md: gs-poster

The point of this repo is that Claude drafts and Gus approves. Keep it that way.

## Hard rules
- Never add an MCP tool, route or code path that publishes, schedules or cancels a Facebook post without Gus's approval on the approval site (GitHub sign-in + PIN). `src/publish.ts` is called only from `src/web.ts` after the PIN check.
- Never weaken the approval guards: allowed GitHub logins, PIN and lockout, CSRF and same-origin checks, the atomic `claimForPublish`.
- Never read, print, log or ask for secret values (Facebook token, PIN, OAuth client secret, Cloudflare token). Never commit `.dev.vars`.
- Never approve a deployment, merge to get around review, or change `.github/workflows/deploy.yml` to skip the `production` environment.
- Changes to anything above need Gus's explicit go-ahead in the conversation, described plainly before you make them.

## Working here
- `npm run check` (typecheck + tests) must pass before pushing. `npx wrangler deploy --dry-run --outdir dist` checks the bundle.
- The house rules in `src/validate.ts` mirror the gsgrimoire-release-schedule skill. If the skill's brand rules change, update both.
- Local end-to-end testing: `npm run dev` with test values in `.dev.vars`. `GRAPH_BASE_URL=http://127.0.0.1:<port>` points Facebook calls at a local mock; it is ignored for any other host.
- Deploys run from `main` via GitHub Actions and wait for Gus's approval.

## Using the connector (for Claude in other sessions)
- Draft with `draft_post`, one post per call, with `label` (e.g. "Day 1 creature reveal"), `release` and `publish_at` in Copenhagen time.
- Tell Gus the drafts are waiting and give him the review link. Never say a post is published until `get_post` shows `published`.
- Rejected posts carry Gus's note in `gus_note`. Revise with `update_draft`.
