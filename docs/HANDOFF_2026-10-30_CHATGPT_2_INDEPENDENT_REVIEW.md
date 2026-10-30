# GS Poster handoff: ChatGPT-2 independent reviewer, 30 October 2026

**Session:** ChatGPT-2 | Independent Reviewer. **Authenticated GitHub login:** `GSGrimoire` (also the pull-request author login; reviewer comments are source-verdict evidence, not formal separate-account approvals).
**Parent source:** `main` at `cf2b274b465c788a27bdee502c2ec9395886b33f` (docs-only PR #51 merge). **Owner's instructions:** never publish on their behalf, never enter/print a PIN or other secret, never relax approval guards.

This handoff supersedes the live status claims in the earlier, explicitly dated Claude-1 handoff and the backlog snapshot merged in #51. Read `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md`, `docs/REVIEW_2026-10-30_CHAT_TO_PLATFORMS.md`, `docs/HANDOFF_2026-10-30_CLAUDE_SESSION.md`, and the GS Tools Hub `docs/REVIEW_PLAYBOOK.md` first.

## Source review and disposition

| Pull request | Exact reviewed head | Depth and source verdict | Merge and runtime gate |
| --- | --- | --- | --- |
| [#52](https://github.com/GSGrimoire/gs-poster/pull/52) | `d735ec747affb8d013fe80304bac25b05393e621` | **Full: Changes required**, reviewer COMMENT [review 5719185325](https://github.com/GSGrimoire/gs-poster/pull/52#pullrequestreview-5719185325) | **Open, unmerged. Do not deploy** until corrected and independently re-reviewed |
| [#53](https://github.com/GSGrimoire/gs-poster/pull/53) | `6a90559bb8568ad70fc9fd9ff797ac8ef7cbf1b2` | **Full: Approved without changes**, source-level COMMENT [review 5719185580](https://github.com/GSGrimoire/gs-poster/pull/53#pullrequestreview-5719185580) | Merged as `8af2f390cc1e6fdfe2009975bf54104c3a93cf2d`; [Deploy 41135802517](https://github.com/GSGrimoire/gs-poster/actions/runs/41135802517) **success**, [live smoke 41135934429](https://github.com/GSGrimoire/gs-poster/actions/runs/41135934429) **success** |
| [#51](https://github.com/GSGrimoire/gs-poster/pull/51) | `b1bbfd6210de7a5928e83094c3ab38cfa4ab772e` | **Mini: Approved as a historical docs snapshot**, source-level COMMENT [review 5719201815](https://github.com/GSGrimoire/gs-poster/pull/51#pullrequestreview-5719201815) | Merged as `cf2b274b465c788a27bdee502c2ec9395886b33f`; [Deploy 41136074219](https://github.com/GSGrimoire/gs-poster/actions/runs/41136074219) **success**, [live smoke 41136197840](https://github.com/GSGrimoire/gs-poster/actions/runs/41136197840) **success** |

**Automated tests:** At pinned PR heads, GitHub Actions CI `41134614639` (#52, 165 tests), `41134767324` (#53, 157 tests) and `41135022850` (#51) all passed `npm run check` and `npx wrangler deploy --dry-run --outdir dist`. The reviewer separately inspected changed and unchanged source but could not independently execute those commands locally: the execution environment cannot resolve GitHub/npm hosts to clone and install the project. No local run is claimed. Check new integration heads after any corrections or merges.

**Whole affected path independently inspected:** `src/web.ts` session validation, origin and cross-site request forgery protection, approval PIN comparison and lockout, versioned approval form, queue progress and reconciliation cards; `src/db.ts` atomic `claimForPublish` and status changes; `src/publish.ts` immediate/queued target selection, retries, Bluesky scheduled claim, stuck reconciliation, redraft and schedule lead time; `src/facebook-queue.ts` approved-only enqueue, atomic queue job and started-at lease claim, image checkpoints, one-way `sending` barrier, manual resume/abandon/remote-identifier reconciliation; `src/index.ts` cron and upload dispatch; `src/mcp.ts` registered Model Context Protocol tools and current editor gates. No Model Context Protocol publishing tool was found.

### Blocking #52 finding and minimum regression

`abandonFacebookUpload` changes a queue job to `cancelled` but leaves the `facebook_upload_jobs` row and the post can be moved `failed -> draft` with a fresh PIN-gated `redraft`. A new owner approval for that same photo post calls `enqueueFacebookUpload`, whose `INSERT ... ON CONFLICT(post_id) DO NOTHING` returns zero changes because the cancelled row already exists. The post fails rather than reentering the cron queue. This affects the newly required photo queue path for every image count, not just large galleries.

**Implementer action:** Claude-1 must correct the entire queue abandonment and reapproval state machine or clearly prohibit same-record recovery and direct the owner to a new draft. Do not reactivate an ambiguous `sending`, `busy` or `done` job. Add end-to-end database regressions for 1/7/11 photos; abandon -> verified redraft -> reapproval; concurrent claims; partial upload; Graph response lost after final send; stale version; scheduled cutoff; and combined Bluesky state. A corrected head requires a new independent Full review. Facebook video remains in the inline request and should get its own queued path later.

#53 only guards **Facebook** target approval when there is no image/video and the label/release says media is pending. It has an explicit owner override; PIN, cross-site request forgery, same-origin and atomic claim remain in force. Follow up in issue #48 with Bluesky-only coverage and web handler integration tests; the added tests mainly exercise the regex helper.

## Production baseline and recovery gate for issue #49

Read-only `get_post` on 30 October confirmed all seven below still have `status=publishing`:

- `p_mvppbkvn27705754cc`: Week 1 Tue Bare campaign openings
- `p_mvppboxrb276c1eb88`: Week 1 Thu Bare shopkeeper lines
- `p_mvppbqdc3cec3cdf0e`: Week 2 Tue GS campaign openings
- `p_mvppbta50b65315858`: Week 2 Wed GS death-save rules
- `p_mvppbuywca87d7ec9d`: Week 2 Thu GS shopkeeper lines
- `p_mvpqp2hmbf680b3b85`: Wed GS challenge-rating 3 creatures
- `p_mvpqpf0u6d853169ab`: Thu Bare challenge-rating 4 creatures

Read-only `list_page_posts` for published and scheduled returned no matching carousel in the available result windows. This is **not** a complete external guarantee of absence; the owner must check Meta Business Suite for the exact post. No recovery, approval, scheduling or Facebook publication was performed.

**Only after corrected #52 is reviewed, merged, deployed and live smoke passes**, guide the owner through one of the seven posts, preferably `p_mvppbkvn27705754cc`:

1. Owner signs in to the review page and checks the exact caption/media against both published and scheduled lists in Meta Business Suite. If present, **do not** mark absent or reapprove; record the existing Facebook identifier and investigate.
2. If definitely absent, owner personally confirms the checkbox and enters their PIN to select **Mark as failed (sends nothing)**. Verify the post is `failed` with `get_post`.
3. Owner personally confirms absence again and enters PIN for **Move back to drafts**. Verify `draft`, correct seven-image order and caption. Its 27 October slot is past, so the owner must clear the old time or select a valid future time; photo schedule must allow at least 30 minutes at approval.
4. Owner alone re-approves. Then use `get_post` and the actual Facebook `list_page_posts` published/scheduled list to compare the single recorded Facebook identifier and ensure no second matching post appears. Do not infer one successful publication merely from `publishing` or a queued record. Leave other six untouched until this gate is proven.

## Native ChatGPT intake, issue #32

**Source deployed, live acceptance blocked.** `src/mcp.ts` registers `import_chatgpt_files` with native file parameters, but this ChatGPT session's connected GS Poster tool inventory does not expose `import_chatgpt_files` or `check_uploads`. The accessible tools include `request_upload`, `get_post`, `list_page_posts`, `draft_post`, etc. No real ChatGPT file parameter handoff can be initiated from this connection; do not claim it succeeded. No media or drafts were written to GS Poster.

Synthetic **test-only** fixtures were created outside the repository (not uploaded to the Worker) for genuine intake acceptance. Local independently measured source bytes:
- `test_single.png` 3,306 bytes, SHA-256 `1c2935e811e44e4dbe562d35a72721ebcd795d9399e305710a47d47447e214ba`.
- `test_video.mp4` 4,725 bytes, SHA-256 `3805b65b824f92b0207936b887b9ba615bc39f3fe3139dbc546c295b6deddb0e`.
- Carousel order: `carousel_1.png` SHA-256 `23909c78d53ec33521433ccce76186effe788d8360a7a5f63bab69ce1364485e`, `carousel_2.png` SHA-256 `da8bb59440f216b4c1207cfd795c8477c81248008bad5830cda3628fff19ebbd`, `carousel_3.png` SHA-256 `2824a358f13373f50d9ff5590105885d071f437e25d3927cf440dde47517db52`.

Next owner/client gate: refresh or reconnect the GS Poster plugin in ChatGPT until `import_chatgpt_files` is actually exposed. Attach actual test PNG, MP4 and ordered three PNG files; pass host-provided file parameters, without copying a signed URL or encoding bytes in model text. Check private readiness, owner scope and independently compare persisted bytes against these source digests. Test invalid and expired URLs, redirect, oversized or corrupted files, cross-owner references, interrupted transfers and secure private browser fallback. Verify no publication occurs. Keep #32 open until complete.

## Outstanding next actions

1. Claude-1 corrects PR #52 in its implementation branch, provides full adversarial recovery evidence; a **different reviewer session** rechecks the exact new head. Do not treat CI green as approval.
2. After merge/deploy/smoke of corrected #52, perform exactly one owner-controlled recovery and one-post check as above. Never use the owner's PIN on their behalf.
3. Refresh/reconnect native ChatGPT GS Poster tool exposure; run #32 attachment, integrity and failure acceptance on test media. Only then consider release-content drafts.
4. #48: expand pre-publish checks and add Bluesky guard/approval handler tests. #50: owner adds Claude app access to the private media staging repository and tests the real original-file bridge.
5. Preserve private R2 ownership and one-use upload grants, no unauthenticated write other than the guarded PUT upload endpoint, no public staging of unpublished media, no Model Context Protocol publishing. No credentials or PIN values were read or recorded.

**Issue evidence:** [#49](https://github.com/GSGrimoire/gs-poster/issues/49), [#48](https://github.com/GSGrimoire/gs-poster/issues/48), [#32](https://github.com/GSGrimoire/gs-poster/issues/32). This new handoff is a reviewer-authored documentation change on a separate branch; by `CLAUDE.md`, its author must not self-merge it.
