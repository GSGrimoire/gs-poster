# GS Poster development backlog

**Reviewed: 2 November 2026, 14:15 Copenhagen (Claude-1 | Implementer, at `main` a61f4b7).** Verify the live GitHub head, issues and deployment evidence before acting. This index is a starting point, not a substitute for live issues.

**Newest handoff:** [2 November status](docs/HANDOFF_2026-11-02_CLAUDE_STATUS.md). **Newest review:** [1 November full security, functional and platform review](https://github.com/GSGrimoire/gs-poster/pull/62) (draft PR #62). Feature handoffs: [Instagram crop and pad](docs/HANDOFF_2026-11-02_CLAUDE_INSTAGRAM_CROP_PAD.md), [per-platform editor](docs/HANDOFF_2026-11-01_CLAUDE_PLATFORM_EDITOR.md), [#63 atomic update](docs/HANDOFF_2026-11-01_CLAUDE_63_ATOMIC_UPDATE.md). For cross-project review policy, read [AGENTS.md](AGENTS.md) and the [GS Tools review playbook](https://github.com/GSGrimoire/gs-tools-hub/blob/main/docs/REVIEW_PLAYBOOK.md).

## Priority queue

| Priority | Work item | Verified state at checkpoint | Next acceptance gate |
| --- | --- | --- | --- |
| P0 | Instagram crop and pad, **production acceptance** | Merged and deployed in #65 (`a61f4b7`). Source-reviewed. Pad and output sizes verified locally; crop position **not** verifiable offline | Signed-in asymmetric-photo test from the status handoff. Until it passes, do not rely on Crop downloads |
| P1 | [One-PIN release, autosave, Post now, earliest valid time, issue #61](https://github.com/GSGrimoire/gs-poster/issues/61) | Owner-approved; not started | Build with per-platform states; Full review; fault-injection tests |
| P1 | Instagram target in MCP `draft_post` / `update_draft` | Editor-only today; `get_post` shows it read-only | Same fenced save as #64; Full review |
| P1 | [Per-platform ordering and one-page bulk upload, issue #33](https://github.com/GSGrimoire/gs-poster/issues/33) | Independent selection exists; Instagram has ordering; Facebook, Bluesky and TikTok do not | Reorder per platform without changing others; mobile check |
| P1 | [Pre-publish check panel, issue #48](https://github.com/GSGrimoire/gs-poster/issues/48) | No-media guard merged earlier; per-platform live checks now in the editor (#65) | Decide what remains (caption window, YouTube pairing) and close or narrow |
| P1 | [Four-phase winter cave battlemap draft, issue #46](https://github.com/GSGrimoire/gs-poster/issues/46) | Draft `p_mvve6u15758e2a8340` exists with 0 of 4 images | Transfer the four originals privately, attach in phase order, owner approval |
| P1 | [Native ChatGPT file transfer, issue #32](https://github.com/GSGrimoire/gs-poster/issues/32) and [Claude blob bridge, issue #50](https://github.com/GSGrimoire/gs-poster/issues/50) | #32 deployed, no live acceptance; #50 blocked on the Claude GitHub App seeing the staging repo | Real original-byte acceptance for each |
| P1 | Review #62 remaining findings | S1, S2 fixed (#64). S3 branch protection: owner GitHub setting. S4 OAuth consent origin/CSRF, S5 GitHub fetch redirects: hardening. S6 TikTok admin PIN: owner decision. S7 Instagram hosting: before any publishing | Merge #62 as docs; track S3 to S6 as issues |
| P2 | Instagram publishing | Not started. Needs owner choices (account, placement, hosting consent) and Meta permissions | Separate design and Full review; never an MCP publish tool |
| P2 | [Dependency vulnerability triage, issue #13](https://github.com/GSGrimoire/gs-poster/issues/13) | 30 Oct: findings only via `agents` -> MCP SDK, not in the Worker bundle | Fresh classified audit |
| P2 | [GS Analytics posting windows, issue #5](https://github.com/GSGrimoire/gs-poster/issues/5) | Depends on GS Analytics #5 | Versioned read-only feed first |
| P2 | [Facebook Groups manual dispatch, #35](https://github.com/GSGrimoire/gs-poster/issues/35); [Reddit, #34](https://github.com/GSGrimoire/gs-poster/issues/34) | Researched | Manual workflows only |

## What is actually live at this checkpoint

- `main` at `a61f4b7`: #64 (atomic, version-fenced `update_draft`) and #65 (per-platform editor cards, platform rules registry, Instagram crop and pad preparation with server-rendered JPEG downloads). Deploy and live smoke succeeded 2 Nov 07:36 to 07:38 UTC.
- #63 live acceptance passed through the production MCP connector on 2 Nov 13:12 UTC (Facebook off persisted; stale version refused; test draft deleted).
- Nothing sends anything to Instagram. There is no Instagram token, adapter or public media hosting.
- #49 (stuck posts) is closed.

## Requirements for every future implementation session

1. State **ChatGPT-1 | Implementer**, **ChatGPT-2 | Independent Reviewer**, or another unique session/role label in work records. Read `AGENTS.md`, `CLAUDE.md` and the Hub review playbook. Classify **Mini review** or **Full review** up front. An implementation session must not approve or merge its own GS Poster source pull request.
2. Inspect current `main`, open pull requests, issues and the precise target head. Keep application changes separate from editorial release prep.
3. For security-sensitive changes, perform a **full affected-system review**, including identity and revocation across **all** tool handlers, private media owner checks, state transitions, database-commit uncertainty and adversarial tests. Passing checks is not security approval.
4. Run `npm run check` and `npx wrangler deploy --dry-run --outdir dist`, and preserve existing GitHub sign-in, owner PIN and publication boundaries. Do not merge or deploy without required approval.
5. Never claim a media file was transferred solely because a model can view it. Independently verify **original bytes**, stored readiness and the correct target order; if the client cannot upload, use the owner's secure private browser fallback. Do not paste large encoded blobs or upload unpublished media into the public source repository.
6. Track source approval, GitHub formal review status, production environment deployment, and real external-provider acceptance as **separate** gates. Do not treat a draft as approved or published.
7. Record a dated handoff with exact issue, draft, commit, tests, limitations, and the next actionable task. Never report unverified work as complete.
