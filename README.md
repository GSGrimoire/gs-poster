# GS Poster

GS Poster prepares Facebook and Bluesky posts for GS Grimoire. Claude, ChatGPT and other authorized MCP clients can create drafts, but each target still requires approval on the site with GitHub sign-in and the approval PIN before it can go out.

One Cloudflare Worker (free plan) does three jobs:

- **MCP server** at `/mcp`. Claude or ChatGPT connects to it as a custom connector and gets tools to draft, revise, list and delete drafts, and read the Page. **There is no publish tool.**
- **Approval site** at `/`. Gus signs in with GitHub, chooses Facebook, Bluesky or both, edits platform captions, image alternative text and publish time, and approves with a PIN. Facebook uses Meta scheduling. Bluesky uses an approved queue served by the Worker's cron trigger.
- **OAuth server**. Connecting an assistant requires Gus's GitHub sign-in plus a consent click.

## Who can do what

| | Connected AI assistant (MCP) | Gus (approval site) |
|---|---|---|
| Draft, revise, delete drafts | yes | edit before approving |
| Read Page posts and the schedule | yes | in Business Suite |
| Publish or schedule | **no** | yes, with PIN |
| Cancel a scheduled post | no | yes, with PIN |
| See Facebook or Bluesky credentials | no | only in the Cloudflare dashboard |

Guards on the approval side: GitHub sign-in limited to `ALLOWED_GITHUB_LOGINS`, a PIN only Gus knows (5 wrong tries lock approvals for an hour), CSRF tokens and same-origin checks, and an atomic draft → publishing step so a double tap cannot post twice. Every action is logged in the Activity list.

Assistant-created drafts must pass the house rules from the release-schedule skill (no em dashes, no prices, no tool names, current tier names). See `src/validate.ts`. On the approval page those rules show as warnings Gus can override.

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
| `BSKY_HANDLE` | Bluesky account handle for the account GS Poster should post as |
| `BSKY_APP_PASSWORD` | a Bluesky **app password**, not your main account password, generated in Bluesky settings |
| `GITHUB_READ_TOKEN` | optional: fine-grained token, *Contents: read* only, for images in private repos |

`COOKIE_SECRET` is created automatically on the first deploy. Never put any of these in the repo or in a chat.

### 5. Meta (Facebook)
In your Meta app (Development mode is fine, since only your own Page is used):
- Permissions for the poster's token: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`.
- Get a long-lived user token, then read `/me/accounts`. The Page token it returns does not expire on a timer. It stops working if you change your Facebook password or lose admin on the Page.
- Keep the analytics dashboard on a **separate, read-only** token.
- Recommended: turn on **Require app secret** in the app's advanced settings and add `FB_APP_SECRET` above. A leaked token alone is then useless.

### 6. Bluesky setup

1. Create a Bluesky app password in your Bluesky account settings, then add `BSKY_HANDLE` and `BSKY_APP_PASSWORD` to **Cloudflare Worker Secrets**, not GitHub. Do not enter the app password into draft text, logs or chat.
2. The Worker configuration includes an `IMAGES` binding for Cloudflare Images, which converts each selected GitHub image to WebP, strips its original metadata and reduces it until the upload is below 1,950,000 bytes. The Cloudflare Images Free plan includes a monthly transformation allowance. The binding must be active at deployment.
3. The configuration schedules a Worker cron trigger every minute. Bluesky has no native scheduled-post endpoint: only previously approved and still-scheduled Bluesky targets can be picked up by this trigger. Actual dispatch timing depends on Cloudflare cron execution.
4. Each Bluesky target gets its own caption (up to 300 grapheme characters), up to four image URLs and **explicit alternative text per image**. Draft authors must write the alternative text from the original image descriptions. The current GitHub image repository does not expose separate description metadata, so GS Poster does not automatically invent descriptions from filenames.
5. The optional free Patreon post card needs a Patreon `/posts/` URL, title and description. With no images, the card is on the post itself. With images, Bluesky's embed limitation requires a second, threaded reply carrying the card.

**Publishing safeguards:** Adding a Bluesky target does not add an MCP publishing tool. Only approval with the existing PIN changes a target to publishable. A Bluesky publish failure remains visible on the review page and can be retried there with the PIN; it never causes Facebook to be posted a second time. For a two-post gallery-and-card thread, deterministic Bluesky record keys guard against duplicates if a network response is lost.

### 7. Connect an assistant
1. Open the site URL and sign in with GitHub once.
2. For Claude: claude.ai → **Settings → Connectors → Add custom connector**, URL = site URL + `/mcp`. For ChatGPT: add a custom MCP server using the same URL in ChatGPT's plugin settings. Sign in with GitHub and choose **Allow**. Reconnect existing clients after a server update if you want the newly saved OAuth client name on future draft and audit records.
3. Ask either assistant to run **check_setup**. It reports anything missing and whether the Page token works.

## Day to day
1. After a Release Schedule session, Claude or ChatGPT drafts posts for Facebook, Bluesky or both. GS Poster records the name of the connected OAuth client alongside the authorized GitHub account for newly connected sessions.
2. You open the site (it works on a phone), check each draft, edit if needed, enter the PIN and approve. Or reject it with a note. Claude sees the note and revises.
3. The approval site's homepage shows a Sunday-through-Saturday calendar in Copenhagen time. Hover over posts for details, click to review or edit pending captions, and drag pending posts to another half-hour slot. Moving an approved schedule requires the PIN and verifies Facebook's updated time; no post is recreated. Times less than 12 minutes away or in the past are unavailable. Released posts remain in previous calendar weeks. Facebook publishes at the set time; GS Poster publishes approved Bluesky targets through Cloudflare's scheduled trigger. You can cancel queued targets from the review site.

Images come from GitHub: the image library's `raw.githubusercontent.com` links, or files in a private repo (needs `GITHUB_READ_TOKEN`). JPG, PNG or GIF up to 10 MB each. Facebook drafts may contain up to **80 photos**. Bluesky supports up to four gallery images with reviewed alternative text; Bluesky images are converted and resized under the 2 MB upload cap.

### Facebook large image posts

Facebook posts with **11 to 80 images** use a durable queue instead of uploading everything in one request. Once approved with the existing PIN, GS Poster uploads **up to eight photos per cron invocation**, preserving their original order and saving each uploaded media ID in the database before moving to the next one. This avoids the Cloudflare Free plan's 50 external-request limit, but 80 images can require ten scheduled runs and several minutes. Scheduled bulk posts therefore need **at least 30 minutes of lead time** when approved; all uploads must complete before the final Facebook scheduling call. Posts without a time go out after the batch queue completes, not immediately after approval.

The review page displays how many images were uploaded. If an upload fails before the feed is created, the existing GitHub sign-in and approval PIN can resume the remaining images. **GS Poster will not automatically retry an ambiguous final Facebook feed submission**, because Meta may have already published it despite a lost response. A human must reconcile that situation on Facebook; otherwise a duplicate is possible.

**Important:** 80 images is a configurable application-side target, **not a verified official Meta per-post limit**. If Meta rejects 80 attachments to one feed post, the queue will report an error. In that case the product needs either a lower cap or a supported album-based publishing strategy. The initial library draft check only downloads the first eight URLs; later images are verified as they are uploaded.

### Initial Bluesky video support

Bluesky supports one video in a post. The service announced support for videos up to 10 minutes and 300 MB in August 2026, but this initial Worker implementation is deliberately narrower: it accepts **one GitHub-hosted MP4 of up to 20 MB**, with a required accessibility description. The video and an image gallery are mutually exclusive. When a free Patreon card is selected alongside a video, the card is published as a threaded reply.

This first implementation uploads the MP4 directly to the Bluesky personal data server, then posts the video reference; **Bluesky may show the video as unavailable briefly while it processes**. It does not yet provide 300 MB transfers, automatic transcoding, pre-publication video processing, captions/subtitles, or automatic duration validation. Large-video support should use a streaming ingest service and `video.bsky.app` processing jobs with durable status tracking. A verified Bluesky account email is required to post videos.

Do not test with a live social account until the branch is independently reviewed and the service credentials are configured in Cloudflare. No new approval-free publishing tool is added.

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
