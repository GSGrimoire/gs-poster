# GS Poster development backlog

**Reviewed:** 29 October 2026

This file indexes actionable work and links to the evidence/design documents in `docs/`. Active work still belongs in GitHub Issues; this file helps an assistant resume safely in a later session.

| Priority | Work item | Status | Reference | Blocker |
|---|---|---|---|---|
| P0 | ChatGPT media intake improvements: batch upload links, batch checks and TikTok-specific caption | In current pull request | [Design](docs/CHATGPT_MEDIA_INTAKE_2026-10-29.md) | Production tests/merge |
| P1 | True no-click ChatGPT attachment transfer | [#32](https://github.com/GSGrimoire/gs-poster/issues/32) | [Design](docs/CHATGPT_MEDIA_INTAKE_2026-10-29.md) | Verify chat-client access to original attachment bytes and binary transfer capability |
| P1 | Better multi-file uploader and independent Facebook/TikTok galleries | [#33](https://github.com/GSGrimoire/gs-poster/issues/33) | [Design](docs/CHATGPT_MEDIA_INTAKE_2026-10-29.md) | New shared-media-target database and UI |
| P2 | Reddit subreddit-specific drafts, rule checking and approved posting | [#34](https://github.com/GSGrimoire/gs-poster/issues/34) | [Reddit](docs/REDDIT_PUBLISHING_RESEARCH_2026-10-29.md) | Reddit API approval and commercial-use permission |
| P2 | Facebook Group manual dispatch with copy/media/reminder/completion | [#35](https://github.com/GSGrimoire/gs-poster/issues/35) | [Facebook Groups](docs/FACEBOOK_GROUPS_RESEARCH_2026-10-29.md) | No supported public API; manual workflow only |
| P2 | Larger reels, upload streaming, audio/subtitle workflow and cover selection | Backlog | [Design](docs/CHATGPT_MEDIA_INTAKE_2026-10-29.md) | Streaming, duration/format validation and storage budget |
| P3 | Direct official Group API integration | Blocked, not planned | [Facebook Groups](docs/FACEBOOK_GROUPS_RESEARCH_2026-10-29.md) | Meta retired Groups API 22 April 2024. Revisit only if an officially supported replacement appears. |

## Instructions for a future implementation session

1. Read `CLAUDE.md` and the relevant source documents. Do not relax the existing account authentication or PIN approval requirements.
2. Examine GitHub Issues and the latest `main` branch before creating a branch. Do not duplicate an open feature or imply an unmerged pull request is deployed.
3. Treat platform capabilities as dated. Recheck official TikTok, Reddit and Meta documentation before implementing a new publishing endpoint.
4. Work on a feature branch and make a pull request. Run `npm run check` and `npx wrangler deploy --dry-run --outdir dist`. Only merge when checks pass.
5. Chat tools should create and edit **drafts only**; any new publishing operation must require explicit authenticated human approval and the existing PIN.

For Claude work, wait until the owner has access again and can test its connected-client file-access capabilities. Do not assume an attachment visible in Claude is automatically available to a remote Model Context Protocol tool.
