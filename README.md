# GS Poster

Claude drafts Facebook posts for the GS Grimoire Page. Gus approves them. Only then do they go out.

One Cloudflare Worker (free plan) does three jobs:

- **MCP server** at `/mcp`. Claude connects to it as a custom connector and gets tools to draft, revise, list and delete drafts, and read the Page. **There is no publish tool.**
- **Approval site** at `/`. Gus signs in with GitHub, reviews each draft (caption, images, time), can edit it, and approves with a PIN. Approving schedules the post on Facebook, or posts it at once if no time is set.
- **OAuth server**. Connecting Claude requires Gus's GitHub sign-in plus a consent click.

## Who can do what

| | Claude (MCP) | Gus (approval site) |
|---|---|---|
| Draft, revise, delete drafts | yes | edit before approving |
| Read Page posts and the schedule | yes | in Business Suite |
| Publish or schedule | **no** | yes, with PIN |
| Cancel a scheduled post | no | yes, with PIN |
| See the Facebook token | no | only in the Cloudflare dashboard |

Guards on the approval side: GitHub sign-in limited to `ALLOWED_GITHUB_LOGINS`, a PIN only Gus knows (5 wrong tries lock approvals for an hour), CSRF tokens and same-origin checks, and an atomic draft → publishing step so a double tap cannot post twice. Every action is logged in the Activity list.

Claude's drafts must pass the house rules from the release-schedule skill (no em dashes, no prices, no tool names, current tier names). See `src/validate.ts`. On the approval page those rules show as warnings Gus can override.

## Setup

You only do this once. Roughly 20 minutes, plus the Meta part.

### 1. Cloudflare
1. In [dash.cloudflare.com](https://dash.cloudflare.com), open **Workers & Pages** once so the account picks a `workers.dev` subdomain.
2. **My Profile → API Tokens → Create Token**. Use the **Edit Cloudflare Workers** template, then **+ Add more**: *Account · D1 · Edit*. Under Account Resources choose your account. Create it and copy the token.

### 2. GitHub repo (this one)
1. **Settings → Secrets and variables → Actions → New repository secret**: `CLOUDFLARE_API_TOKEN` = the token from step 1.2.
2. **Actions → Deploy → Run workflow**. The run summary shows the site URL, e.g. `https://gs-poster.<you>.workers.dev`.

### 3. GitHub sign-in app
[github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**
- Application name: `GS Poster`
- Homepage URL: the site URL
- Authorization callback URL: the site URL + `/callback`

Create it, then **Generate a new client secret**. Keep the Client ID and the secret for the next step.

### 4. Worker secrets
In [dash.cloudflare.com](https://dash.cloudflare.com): left sidebar **Compute (Workers) → Workers & Pages** → click **gs-poster** → **Settings** tab → **Variables and Secrets** → **+ Add**. Set Type to **Secret**, enter the name exactly, paste the value, then **Deploy**. These go in Cloudflare, not in GitHub's repo secrets (only `CLOUDFLARE_API_TOKEN` lives there).

| Name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | from step 3 |
| `GITHUB_CLIENT_SECRET` | from step 3 |
| `APPROVE_PIN` | a PIN of 6 or more digits that only you know |
| `FB_PAGE_ID` | the GS Grimoire Page ID |
| `FB_PAGE_TOKEN` | a long-lived Page access token (below) |
| `FB_APP_SECRET` | optional, recommended: your Meta app's secret, if you turn on "Require app secret" |
| `GITHUB_READ_TOKEN` | optional: fine-grained token, *Contents: read* only, for images in private repos |

`COOKIE_SECRET` is created automatically on the first deploy. Never put any of these in the repo or in a chat.

### 5. Meta (Facebook)
In your Meta app (Development mode is fine, since only your own Page is used):
- Permissions for the poster's token: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`.
- Get a long-lived user token, then read `/me/accounts`. The Page token it returns does not expire on a timer. It stops working if you change your Facebook password or lose admin on the Page.
- Keep the analytics dashboard on a **separate, read-only** token.
- Recommended: turn on **Require app secret** in the app's advanced settings and add `FB_APP_SECRET` above. A leaked token alone is then useless.

### 6. Connect Claude
1. Open the site URL and sign in with GitHub once.
2. claude.ai → **Settings → Connectors → Add custom connector**, URL = site URL + `/mcp`. Connect, sign in, **Allow**.
3. Ask Claude to run **check_setup**. It reports anything missing and whether the Page token works.

## Day to day
1. After a Release Schedule session, Claude drafts the Facebook posts with their times.
2. You open the site (it works on a phone), check each draft, edit if needed, enter the PIN and approve. Or reject it with a note. Claude sees the note and revises.
3. Facebook publishes at the set time. You can cancel from the site or in Business Suite.

Images come from GitHub: the image library's `raw.githubusercontent.com` links, or files in a private repo (needs `GITHUB_READ_TOKEN`). JPG, PNG or GIF up to 10 MB, at most 10 per post.

## Who reviews changes
Whoever can change this code controls what the server does, so changes go through a second pair of eyes. As in gs-scribe, Gus does not review code: Claude works on a branch and opens a pull request, ChatGPT reviews it against the checklist in `CLAUDE.md` and merges, and merging to `main` deploys. Claude never pushes to `main` or merges its own pull requests.

This is a working agreement between the two assistants. GitHub only enforces review rules on private repos on paid plans, so nothing technically stops a direct push. The approval PIN still guards every post at runtime.

## Development
```
npm ci
npm run check      # typecheck + tests
npm run dev        # local server; put test values in .dev.vars
```
Not built yet: video posts (the Day 1 reveal with music needs Facebook's resumable video upload).
