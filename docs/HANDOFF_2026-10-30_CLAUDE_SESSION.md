# GS Poster handoff: Claude session, 30 October 2026 (evening)

**Session:** Claude-1 | Reviewer and Implementer (one Claude session, owner-requested).
**Base:** `main` at `082cf7b` (native ChatGPT intake merged and deployed; Deploy and live smoke green).
**Scope:** full review, two code fixes on branches, documentation. No merge, no deploy, no approval, no draft or post created or changed. Owner asked to focus on the tool, not on individual posts.

## What is waiting for you

| PR | What | Review depth | CI | State |
| --- | --- | --- | --- | --- |
| [#52](https://github.com/GSGrimoire/gs-poster/pull/52) | Fixes #49. Every Facebook photo post goes through the durable cron queue (`BULK_FACEBOOK_THRESHOLD` 10 → 0). New PIN-gated `reconcile-stuck` action moves a stranded `publishing` post (no Facebook id, no queue job, 15+ minutes old, version-matched) to `failed`; sends nothing. 11 new tests; with the old threshold, 4 of them fail. `CLAUDE.md` rule 1 and checklist item 2 reworded to match. | **Full** | green | Needs independent review; implementer must not approve |
| [#53](https://github.com/GSGrimoire/gs-poster/pull/53) | Part of #48. Approval of an empty Facebook post whose label or release says media is pending (pending, HOLD, attach, TBA, TBD) needs an explicit "Publish without media anyway" tick. Refusal only. 3 new tests. | Full (small) | green at push | Needs independent review |
| [#51](https://github.com/GSGrimoire/gs-poster/pull/51) | Docs: full review (`docs/REVIEW_2026-10-30_CHAT_TO_PLATFORMS.md`), `BACKLOG.md` reprioritised, `CHAT_MEDIA_WORKFLOW.md` paths C and D, this handoff. | Mini | green | Docs only |

#52 and #53 touch different lines of `src/web.ts`; either can merge first.

## Verified facts (30 Oct, read-only)

- `npm run check`: 154/154 on `main`; 165/165 on #52; 157/157 on #53. Bundle dry-runs build.
- Seven approved 7-photo carousels from 26 Oct sit in `publishing` with no Facebook id. Facebook's published and scheduled lists contain none of them: `p_mvppbkvn27705754cc`, `p_mvppboxrb276c1eb88`, `p_mvppbqdc3cec3cdf0e`, `p_mvppbta50b65315858`, `p_mvppbuywca87d7ec9d`, `p_mvpqp2hmbf680b3b85`, `p_mvpqpf0u6d853169ab`.
- `check_setup`: no missing secrets; Facebook reachable (Graph v24.0); Bluesky configured; R2 and Images bound; private GitHub staging reachable; upload budget about 1% used.
- `npm audit --omit=dev`: 3 findings, all via `agents` → MCP SDK → express/ajv; none of those modules are in the built Worker bundle (source-map check). Commented on #13.
- Claude cloud sessions cannot reach the Worker (network allowlist, `CONNECT 403`). Their proxy also refuses GitHub REST `git/blobs` writes and branch deletion, but allows `git push`. Pushing a 4.4 MB PNG and reading the blob back by `git hash-object` SHA returned identical SHA-256. Route documented as path D in `CHAT_MEDIA_WORKFLOW.md`.

## Credentials, tokens and access

- **No new token, secret, OAuth client or webhook was created, and no secret value was read.** `check_setup` reports presence only.
- Existing Worker secrets relevant to media intake: `GITHUB_READ_TOKEN` (read-only, staging repo) and `GITHUB_STAGING_REPO`. The staging repository is **`GSGrimoire/GSGrimoire-gs-poster-media-staging`** (private), now named in `CHAT_MEDIA_WORKFLOW.md` so Claude can find it.
- **Owner action needed:** the Claude GitHub App cannot see the staging repository (`add_repo`: "you don't have access"). Add it under GitHub, Settings, Applications, Claude, Configure, Repository access. Same for `gs-hub-runtime-fixtures` if Claude should work there.
- **Clean-up needed:** a throwaway branch `claude/staging-route-test` was pushed to `GSGrimoire/gs-tools-hub` while testing the route. It holds one synthetic noise PNG and nothing else. Claude's proxy refused to delete it; please delete the branch.

## Other records created this evening

- gs-poster issues: #49 (P0 stuck publishing), #50 (Claude intake route); comments on #48 (no-media guard) and #13 (audit reachability).
- gs-poster issue #48 (pre-publish check panel), gs-analytics #6 (own-median outlier ranking), gs-scribe #32 (Whisper vs Parakeet benchmark), gs-tools-hub #48 (OpenCut watch, revisit on or after 13 Nov).

## Next actions, in order

1. **Review #52 (Full).** Checklist in `CLAUDE.md`; focus on the atomic UPDATE in `reconcileStuckPublishing`, the knock-on effects of threshold 0 listed in the PR (30-minute lead for scheduled photo posts, `retryFailedFacebook` refusing photo posts), and that no MCP tool reaches the new action. Merge only with an independent decision recorded.
2. After #52 deploys: these actions need Gus's GitHub sign-in and PIN, so guide him through one stuck post: "Mark as failed (sends nothing)", then "Move back to drafts", then re-approve. Confirm with `get_post` and `list_page_posts` that the cron queue posted it exactly once, then the remaining six can follow. Never approve on Gus's behalf.
3. **Review #53**, then #51.
4. **Native ChatGPT intake live acceptance (#32)**: run the list in `docs/NATIVE_CHATGPT_FILEPARAMS_2026-10-30.md` with a real PNG, MP4 and a 3-file ordered batch. Use test media or the winter cave set (#46) only if Gus asks; the owner asked to focus on the tool.
5. Once Gus grants Claude access to the staging repo, a Claude session should run path D end to end (#50).
6. Follow-ups from #52: a queued path for Facebook video; a "record existing Facebook id" action for a stranded post that did post.
7. Then: rest of the pre-publish panel (#48), one real TikTok inbox carousel and video, #33 multi-upload and per-platform ordering, YouTube as next platform.

## Handoff prompt for ChatGPT

> You are **ChatGPT-2 | Independent Reviewer** for `GSGrimoire/gs-poster`. Read `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md`, `docs/REVIEW_2026-10-30_CHAT_TO_PLATFORMS.md` and `docs/HANDOFF_2026-10-30_CLAUDE_SESSION.md`, plus the Hub review playbook. Claude-1 implemented two changes you must review independently: **PR #52** (Full review: every Facebook photo post through the cron queue, and a PIN-gated `reconcile-stuck` action for posts stranded in `publishing`; fixes #49) and **PR #53** (small Full review: refuse an empty approval when the post's name says media is pending; part of #48). PR #51 is docs only. Verify each exact head, run `npm run check` and `npx wrangler deploy --dry-run --outdir dist`, walk the whole affected path (approval, queue claim and barrier, redraft, page rendering, MCP tools), and record a decision on each PR. Merge only what passes, one at a time, and watch Deploy and live smoke. After #52 is live, walk the owner through recovering one of the seven stuck posts listed in the handoff (the actions need his sign-in and PIN) and verify the single queued Facebook post with `get_post` and `list_page_posts`. Then run the live acceptance for native ChatGPT intake (#32) with test media. Record every result, blocker and next step on the GitHub issues and in a new dated handoff. Never publish, never weaken the approval guards, never print secrets.
