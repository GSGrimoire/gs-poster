# GS Poster handoff: ChatGPT-2 independent reviewer, 31 October 2026

**Session:** ChatGPT-2 | Independent Reviewer. **Connected GitHub account:** `GSGrimoire`, shared by implementer and reviewer sessions. Session labels provide provenance, not distinct authenticated GitHub review identities.
**Repository:** `GSGrimoire/gs-poster`. **Change review depth:** Full for PR #52 and issue #49; Mini for docs-only PR #54.
**Safety:** No post was approved, published, scheduled, reconciled, redrafted or moved. No credential or owner PIN was requested or read. No source or deployment configuration was modified. This handoff is documentation on its own branch, not a release.

## Instructions and source read

Read `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md`, `docs/HANDOFF_2026-10-30_CHATGPT_2_INDEPENDENT_REVIEW.md` on PR #54 head `eaa7c7c652332924d01137ec0b42dcb78ce71a28`, `docs/HANDOFF_2026-10-31_CLAUDE_PR52_FIX.md` on PR #52 head `bca57147a2e797e8dcdb57a884adae5e2c99a0a3`, and the private Hub `docs/REVIEW_PLAYBOOK.md` and `AGENTS.md`. Existing hard rules forbid self-merging, unapproved publication, weakening PIN/CSRF/origin/claim checks and disclosing secrets.

## Pull requests and source review

| Pull request | Immutable head | Independent result | Runtime status |
| --- | --- | --- | --- |
| [#54](https://github.com/GSGrimoire/gs-poster/pull/54), docs only | `eaa7c7c652332924d01137ec0b42dcb78ce71a28` | Mini, only `BACKLOG.md` and the 30 October handoff. CI [41136386908](https://github.com/GSGrimoire/gs-poster/actions/runs/41136386908) passed. Owner requested a separate session to merge, but **the present reviewer authored it**, so `CLAUDE.md` still forbids this session from merging it. [Provenance comment](https://github.com/GSGrimoire/gs-poster/pull/54#issuecomment-6539475181). | **Open, unmerged.** A different authorized reviewer/maintainer must handle it. |
| [#52](https://github.com/GSGrimoire/gs-poster/pull/52), Facebook queue and recovery | `bca57147a2e797e8dcdb57a884adae5e2c99a0a3` | **Full: CHANGES REQUIRED**, [review 5721435839](https://github.com/GSGrimoire/gs-poster/pull/52#pullrequestreview-5721435839). Previous 30 October cancelled-job upsert blocker corrected; new recovered-owner editor gate failure remains. | **Open, unmerged. No Deploy or live smoke for this head.** Do not recover production posts until corrected PR passes and is live. |

### Exact-head continuous integration

On PR #52 exact head, GitHub Actions [CI run 41170750380](https://github.com/GSGrimoire/gs-poster/actions/runs/41170750380), job `check`, finished **success**. Its recorded steps `npm ci`, `npm run check`, and `npx wrangler deploy --dry-run --outdir dist` all completed **success**. Claude-1 reports 181 tests passed locally, but this reviewer did not independently rerun the suite. PR #54 exact-head CI run 41136386908 likewise recorded both required commands as passed. Green automation is not proof of the owner edit flow, deployment, or real Facebook acceptance.

### Full affected-path inventory and trust invariants

- **Owner web entry:** `src/web.ts` `requireSession`, GitHub login allowlist and OAuth callback, same-origin and cross-site request forgery token checks, PIN comparison and lockout precede privileged `postAction` paths. Approval additionally checks the current draft/version, chosen targets, media readiness and scheduled lead time.
- **Claim:** `src/db.ts` `claimForPublish` transactionally changes a version-matched draft to `publishing` and captures approved targets; only the owner PIN route calls `approveAndPublish`.
- **Publication selection:** `src/publish.ts` threshold zero queues every approved Facebook photo post. Text-only and video paths still send in the approval request; video is a known separate risk/follow-up. Bluesky scheduling and retry use an approved target claim.
- **Queue and uncertain Graph completion:** `src/facebook-queue.ts` `enqueueFacebookUpload` atomically permits a new row only for approved `publishing` posts with `fb_post_id IS NULL`. On conflict, resets `media_ids`, `next_index`, `status`, `started_at` and `error` only for old `cancelled` or `done` rows, never `uploading`, `busy`, `sending`, or `failed`. Cron only claims approved `publishing` jobs, fences each photo checkpoint against `started_at`, enforces the last-send schedule lead, and crosses a one-way `sending` barrier. A lost final response is not automatically resent.
- **Recovery:** Owner-only PIN paths in `src/web.ts` handle `abandon-facebook`, `reconcile-facebook`, `reconcile-stuck`, `redraft` and `restore-cancelled`. Stuck reconciliation requires at least 15 minutes, version match, no recorded Facebook identifier and no queue row; its database write does not make a Facebook request. Existing queue abandonment is a human decision. A cancelled scheduled Facebook object is checked via Graph before `reopenCancelledDraft` clears old approval. Active/published Bluesky blocks reopening.
- **Tools and storage:** `src/mcp.ts` registers drafts, read-only post/Page calls, native import and private media helpers. It registers no PIN approval or publishing action. `src/index.ts` exposes cron publication and the established protected web and Model Context Protocol entry points. No upload/private-storage or authentication source changed by this PR. The guarded single-use private upload route is unaffected.

### Blocking finding and regression required

Owner decision, 31 October: **cancelled or abandoned posts must be recoverable as editable drafts and postable later**, rather than forcing a different post record.

**Source-level reproduction:** After `abandonFacebookUpload` leaves a job `cancelled` and post `failed`, `backToDraft` in `src/publish.ts:424-437` changes it to `draft` but **does not clear `approved_at` or the stale scheduled time**. The web page visibly offers editing and time controls to `draft` records (`src/web.ts:539-563`). Yet `editPendingCaptions` (`src/publish.ts:321-330`) and `updateCalendarCaptions` (`src/db.ts:282-285`) require a draft to have `approved_at IS NULL`. The corresponding `reschedulePost` (`src/publish.ts:252-260`) and `updateCalendarTime` (`src/db.ts:267-269`) have the same requirement. Thus owner-verified abandoned/stuck recovery yields a draft whose displayed caption and time controls fail to save. The new `test/requeue-after-abandon.test.ts:84-85` uses `updatePost` directly to simulate editing and **does not exercise production web edit handlers**.

MCP `update_draft` can still edit that record, and the owner can type a fresh caption/time at the next approval, so this is not proof of an approval bypass. But it does not satisfy the chosen editable-draft workflow on the owner review page. `restoreCancelledPost -> reopenCancelledDraft` already revokes approval and clears schedule transactionally; reconcile the differing recovery paths without weakening the owner or Graph-absence gates.

**Required implementer correction:** Make failed-post `backToDraft` revoke the stale approval and normalize the obsolete schedule with appropriate atomic/version checks, while refusing known Facebook identifiers and preventing active/published Bluesky reapproval. Add integration regression through actual owner web caption/time handlers after PIN-gated abandoned-queue and stuck-post recovery, plus 1/7/11 images, fresh re-approval, single queue job, stale approval form, ambiguous final send, and combined Bluesky states. Re-run both required checks. A different reviewer session must re-review the exact corrected head before merge.

**Other findings and limitations:** `done` with a cleared Facebook identifier is necessary for verified-cancelled schedule restoration and the fresh-approval upsert is otherwise bounded correctly. The changed SQL does not reactivate active, failed or ambiguous jobs. These verified properties do not cancel the editor blocker. Facebook video remains inline, and reconciliation after a genuinely successful but unrecorded final Facebook send still needs a manual mapping path. No real Meta sending test was performed.

## Issue #49 live read-only checkpoint and future recovery gate

At this review, `get_post(p_mvppbkvn27705754cc)` reported **status `publishing`**, seven images, `facebook_post_id=null`, label `Week 1 Tue, Bare: campaign openings`, and a past scheduled time of **27 October 2026, 19:00 Copenhagen**. The latest 50 published Page entries and all two returned scheduled entries did not show an obvious match, but a bounded Page listing is **not** a complete guarantee of absence. No owner action or GS Poster state transition occurred. Six other known stuck records from the 30 October handoff were not touched.

Only **after** a corrected PR #52 merges, production **Deploy and live smoke both succeed**, guide the owner through a **single** recovery:

1. Owner opens [the existing post review page](https://gs-poster.goofyspook.workers.dev/post/p_mvppbkvn27705754cc) and personally checks both published and scheduled posts in Meta Business Suite for the exact caption and seven images. If found, stop and investigate its actual Facebook identifier. Never assert absence solely from a bounded connector list.
2. If genuinely absent, owner ticks the site's absence confirmation and personally enters their PIN to select **Mark as failed (sends nothing)**. Independently verify `get_post` is `failed` before going on.
3. Owner repeats the absence check, confirms it on the site and personally authorizes **Move back to drafts**. Verify `get_post` becomes `draft`, seven images remain in the correct order, and the caption is intact. Remove the expired 27 October schedule or choose a new valid future time; queue photos require at least 30 minutes at approval.
4. Owner may edit and later reapprove. Verify with `get_post`, then query Facebook's published **and** scheduled Page lists and compare actual Facebook identifier and content. Confirm **exactly one** corresponding Facebook post, not zero and not two, before touching any of the other six. A GS Poster `publishing` state or queued job alone is not a successful Facebook publication.

[Issue #49 status comment](https://github.com/GSGrimoire/gs-poster/issues/49#issuecomment-6539475606) records the blocker and baseline. Leave issue #49 open until the one-post production acceptance succeeds.

## Issue #32 native ChatGPT attachment intake

Connected GS Poster tool inventory in this reviewer session exposes `request_upload`, `check_upload_usage`, drafts and read-only post/Page tools, but **does not expose** `import_chatgpt_files` or `check_uploads`. Both names appear registered in `src/mcp.ts` at PR #52 head; source registration does not establish client exposure.

**Owner action:** refresh the GS Poster app in ChatGPT, or disconnect and reconnect it in Settings -> Plugins if the stale tool set persists. Stop the native acceptance here. No file parameter handoff, original-byte digest comparison, upload, draft, approval or publication occurred. When both tools appear, use the five synthetic image/video test fixtures and the independently recorded SHA-256 source digests in the 30 October handoff on PR #54. Verify single PNG, MP4, ordered three-image carousel, stored readiness, editor ownership, original bytes, invalid/expired redirects, size/signature failures and the private fallback. Keep issue #32 open until this live acceptance succeeds. [Issue #32 comment](https://github.com/GSGrimoire/gs-poster/issues/32#issuecomment-6539475884).

## Next actionable owner and implementer steps

1. **Claude-1 | Implementer:** correct PR #52 recovered-draft web editing and obsolete-approval state. Add tests through actual handlers and rerun required check and dry-run. Do not merge the current head.
2. **Independent reviewer session:** redo Full review on the new immutable head, give a source-level verdict, then, only if approved and repository rules allow, merge PR #52 **alone** and verify Deploy and live smoke independently. Same GitHub login cannot supply a formal independent-account approval.
3. **Owner after production success:** personally check Meta, use the site confirmation and their own PIN for exactly one recovery, then await read-only verification before touching the remaining six.
4. **Owner for #32:** refresh or reconnect GS Poster until `import_chatgpt_files` and `check_uploads` appear; then perform genuine original-byte acceptance.
5. **Different authorized maintainer/reviewer:** decide merge of PR #54. Its author must not self-merge. This 31 October handoff is itself reviewer-authored and must also be reviewed/merged by someone else.

**Record provenance:** The present reviewer wrote source verdict via a COMMENT review on PR #52, not a formal independent-account APPROVE. This dated documentation branch and pull request have not been self-merged. No post was published or approved by the assistant.
