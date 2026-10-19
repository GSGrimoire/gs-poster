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
2. **Settings → Environments → New environment** `production`. Tick **Required reviewers** and add yourself. From then on every deploy waits for your click, so no code change goes live without you seeing it. GitHub only offers required reviewers on private repos with an Enterprise plan; see "Deploy gate" below.
3. **Actions → Deploy → Run workflow**. Approve it when it asks. The run summary shows the site URL, e.g. `https://gs-poster.<you>.workers.dev`.

### 3. GitHub sign-in app
[github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**
- Application name: `GS Poster`
- Homepage URL: the site URL
- Authorization callback URL: the site URL + `/callback`

Create it, then **Generate a new client secret**. Keep the Client ID and the secret for the next step.

### 4. Worker secrets
Cloudflare dashboard → **Workers & Pages → gs-poster → Settings → Variables and Secrets → Add**, type **Secret** (not Text: Text values are wiped by the next deploy):

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
In your Meta app:
- Permissions for the poster's token: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`.
- Get a long-lived user token, then read `/me/accounts`. The Page token it returns does not expire on a timer. It stops working if you change your Facebook password or lose admin on the Page.
- Keep the analytics dashboard on a **separate, read-only** token.
- Recommended: turn on **Require app secret** in the app's advanced settings and add `FB_APP_SECRET` above. A leaked token alone is then useless. Add the secret to Cloudflare first, and note it also applies to anything else using the same Meta app.
- **Switch the app to Live.** Posts made by an app in Development mode are shown only to people with a role on the app, so fans would not see them (or would see them without images). Going Live asks for a privacy policy URL and data deletion instructions: use the site URL + `/privacy` for both. For your own Page, standard access should be enough; if Meta asks for App Review, stop and check what it wants.

### 6. Connect Claude
1. Open the site URL and sign in with GitHub once.
2. claude.ai → **Settings → Connectors → Add custom connector**, URL = site URL + `/mcp`. Connect, sign in, **Allow**.
3. Ask Claude to run **check_setup**. It reports anything missing and whether the Page token works. The site's **setup** page (site URL + `/setup`) shows the same, plus whether Claude has connected.

## Day to day
1. After a Release Schedule session, Claude drafts the Facebook posts with their times.
2. You open the site (it works on a phone). Drafts are listed by day; each one shows a preview laid out like the Facebook feed. Edit the caption or time and **Save changes** (no PIN), or enter the PIN and approve. Or reject it with a note: Claude sees the note and revises, and the note stays on the revised draft so you can compare.
3. Facebook publishes at the set time. You can cancel from the site or in Business Suite.

Images come from GitHub: the image library's `raw.githubusercontent.com` links, or files in a private repo (needs `GITHUB_READ_TOKEN`). JPG, PNG or GIF up to 10 MB, at most 10 per post.

## Deploy gate
Whoever can change this code controls what the server does. That's why deploys are meant to wait for your approval in the `production` environment. Claude's GitHub access in these sessions cannot approve deployments.

On a private repo, GitHub only offers required reviewers with an Enterprise plan. Without them the `production` environment does not pause, and every push to `main` deploys straight away. The options are to make the repo public (it contains no secrets) and then add yourself as a required reviewer, or to change the workflow so pushes to `main` only run checks and deploys happen only when you run the workflow by hand.

## Development
```
npm ci
npm run check      # typecheck + tests
npm run dev        # local server; put test values in .dev.vars
```
Not built yet: video posts (the Day 1 reveal with music needs Facebook's resumable video upload).
