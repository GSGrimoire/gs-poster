# Reddit publishing feasibility for GS Poster

**Researched:** 29 October 2026  
**Decision:** **Conditionally feasible**, but **do not implement live Reddit publishing until Reddit approves the actual use case**. No Reddit account, application credentials, test post or subreddit have been connected or used.

## Findings and authoritative sources

1. Reddit documents the authenticated `POST /api/submit` endpoint for submitting posts into a subreddit. The Data API also documents `GET /api/v1/subreddit/post_requirements` to inspect moderator-defined requirements, such as title length, body restrictions and link-domain rules.
   - https://www.reddit.com/dev/api/
2. Reddit's **Responsible Builder Policy**, updated 5 October 2026, requires **explicit API access approval**. It prohibits spam, including posting identical or substantially similar content across subreddits. An OAuth token and descriptive User-Agent are required for authenticated Data API clients.
   - https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
   - https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
3. Reddit treats development on behalf of a business or monetized product as potentially commercial. Commercial use needs Reddit's permission and may require a contract. GS Grimoire's product-promotion scenario should be **submitted as potentially commercial**, not assumed to qualify as private non-commercial use.
   - https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data
4. Reddit distinguishes external integrations from Developer Platform (Devvit) apps. For GS Poster, an external Cloudflare Worker, Reddit's developer FAQ directs external websites and bots to **Data API approval**, not to assume Devvit credentials solve external access. Devvit apps generally require moderator installation for community integration.
   - https://developers.reddit.com/docs/guides/faq
   - https://support.reddithelp.com/hc/en-us/articles/30641870735508-Reddit-Developer-Platform-apps

## Proposed GS Poster workflow after approval

### Identity and destinations

- A dedicated Reddit account authorization flow using official OAuth, with encrypted tokens, limited scopes and disconnect/revoke support.
- Store subreddit names and rules as *user-supplied destinations*, not infer membership or posting permission from a name.
- For each subreddit, check its current post requirements and moderator rules before a publish attempt, recognizing that API responses may not cover every rule.
- A **post package per subreddit**: title, markdown body, link, optional images, optional video, suitable post flair, content tags or warnings, media rights, and promotional-disclosure notes.
- Distinguish `self` (text), `link`, and media formats. Reddit galleries and video require separate endpoint discovery and an end-to-end approved test before advertising support; do not assume Facebook/TikTok media payloads work unchanged.

### Human oversight and anti-spam controls

- Every destination needs an explicit per-subreddit approval using the existing GitHub session and publishing PIN. A single draft may have multiple *independent* subreddit targets with tailored copy and status.
- **Never automatically repost identical copy across a list of communities.** Provide a tailored draft for each with a community-fit check and a suggested spacing policy; respect moderator no-promotion rules and user consent.
- Use an idempotency/attempt record before any network submission and reconcile ambiguous outcomes manually. Record submitted post ID, permalink, timestamps, and rejection/moderation status.
- No new Reddit publishing tool available directly through the chat connector. The Model Context Protocol connector should only prepare drafts, not bypass GS Poster approval.
- Offer **manual Reddit handoff** while approval or media support is unavailable: a per-subreddit draft, link to submit in the community, caption/title, media download, and a self-reported completion state.

## Implementation stages

1. **Access gate, P0 dependency:** owner applies to Reddit describing GS Grimoire promotional/editorial integration, planned volumes, account owner, communities and data handling. Record approval and authorized scopes *outside version control*.
2. **Community-aware draft planner:** subreddit destination metadata, title/body/flair, requirements checklist, and manual submission mode. No API token needed.
3. **Read-only research and preflight:** after approval, implement OAuth and fetch per-subreddit requirements. Cache briefly and show stale/unknown state explicitly.
4. **Approved text/link posting:** PIN-gated per-target `POST /api/submit`, with retries disabled on uncertainty, rate limits, moderation handling and tests.
5. **Media posting:** test actual approved gallery/video upload workflows separately, and document any platform restrictions.

## Acceptance criteria

- Never post to a subreddit without valid Reddit approval, credentials, explicit user selection and PIN.
- Demonstrate a test in a permitted test community with mod rules verified.
- Respect rate limits, spam restrictions, flair and sensitive-content requirements.
- User can see *draft*, *awaiting human action*, *submitted*, *removed/held*, and *failed* separately. 'Accepted by API' does not mean 'visible in the subreddit'.
- Support a kill switch to disable all Reddit API writes independently of Facebook, Bluesky and TikTok.

## Open questions for the owner

- Which exact subreddits permit tabletop-game product promotion and image galleries?
- Should posting occur as an individual account, branded account, or both?
- Does Reddit approve the proposed activity as commercial, and at what limits?
- Is manual handoff sufficient initially, pending approval?

**No live Reddit code should be written based solely on the availability of `POST /api/submit`. Access approval and community-specific rules are prerequisites.**
