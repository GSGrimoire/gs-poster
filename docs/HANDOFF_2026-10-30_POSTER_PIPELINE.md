# GS Poster handoff: pipeline priorities and four-phase winter cave map

**Checkpoint:** 30 October 2026  
**Session:** ChatGPT-1 | Editorial preparation and backlog maintainer  
**Scope:** GitHub documentation and unapproved GS Poster editorial draft. No code edits, native importer merge, production approval, or social publication.

## Read these first in a new session

1. [GS Poster shared agent rules](../AGENTS.md) and [hard rules](../CLAUDE.md). Follow the [Hub Mini/Full review playbook](https://github.com/GSGrimoire/gs-tools-hub/blob/main/docs/REVIEW_PLAYBOOK.md). State your unique session ID and assigned role.
2. [BACKLOG.md](../BACKLOG.md), [native transfer issue #32](https://github.com/GSGrimoire/gs-poster/issues/32), [native source pull request #44](https://github.com/GSGrimoire/gs-poster/pull/44), and [winter cave battlemap release issue #46](https://github.com/GSGrimoire/gs-poster/issues/46).
3. Verify live repository and connected GS Poster state instead of assuming this checkpoint remains current.

## Verified release-preparation work

**Four matching original assets** were found in the owner's **ChatGPT Library**. These are the 29 October 2026 four generated PNGs, not the separate Black Kiln encounter art. They depict the same snowy cave approach with an escalating blizzard, in this order:

| Order | Library image filename | Original byte count | Independently computed SHA-256 |
| --- | --- | ---: | --- |
| 1 | `image-gen-1(1).png` | 3,933,180 | `d133acc208029e0496d745069ea528484ee2497466993e3a6696c1886c0a9400` |
| 2 | `image-gen-2(1).png` | 3,551,135 | `8e5c197b33381e0f5cee4536b45a8261f19d9531021f8b6b92dba50929a70528` |
| 3 | `image-gen-3.png` | 3,160,705 | `5f4c612ce3f68b16458ad7579f385613afd72336181bb62103e40fc0f11b168a` |
| 4 | `image-gen-4.png` | 2,877,830 | `2de3c7aad2394717f37821244c2f38eed5cd6259869c193d064bf8fff83688d0` |

Each file is 1024 x 1536 PNG and under GS Poster's per-image limit. The assets were visually compared and the phase progression checked. The original bytes were materialized in the preparing session, but **its temporary local container paths are not a durable cross-chat storage location**. A new session must search the owner's ChatGPT Library by exact filename and creation date, materialize only the relevant originals, and recompute the hashes. Do not substitute newly generated images, simulate media transfers, or upload unpublished originals to this public code repository.

**GS Poster editorial draft already created:**
- Identifier: `p_mvve6u15758e2a8340`.
- [Owner's review page](https://gs-poster.goofyspook.workers.dev/post/p_mvve6u15758e2a8340).
- Status: `draft`, Facebook only; Bluesky/TikTok **not** enabled.
- Label: `HOLD - winter cave battlemap, 4 images pending`.
- Release grouping: `Four-phase winter cave battlemap` (provisional, not an owner-confirmed product title).
- Saved Facebook caption:

  > A winter path, a cave entrance, and a storm that keeps getting worse.
  >
  > This four-phase battlemap takes the same encounter from clear tracks through deepening snowfall to a near-whiteout. Give your players a reason to hurry, find shelter, or face what waits inside.
  >
  > Which phase would you start with?
  >
  > #GSGrimoire #Battlemap #FantasyMaps

- `images: []`, zero attached images. No scheduled publish time. GS Poster returned `saved:true`, `status:draft`, and an editorial warning that there is no Archive/Patreon call to action.
- **Do not approve this incomplete draft. No media were transmitted.**

**Why file transfer stopped:** The session's Python/container environment had the exact image bytes but could not resolve `gs-poster.goofyspook.workers.dev` (DNS failure). The connected GS Poster tool set exposes one-time upload-link requests and draft edits but no direct action taking raw binary bytes. For privacy and integrity, no imaginary `upload://` values, screenshot replacements, public source commits, or guessed image URLs were supplied.

## Next session, editorial path

1. Read GS Poster draft using `get_post`; if already completed or changed by another session, reconcile before acting. Keep the original draft rather than making duplicates.
2. Retrieve the four verified Library images in order, and compare original SHA-256 hashes.
3. If a trusted upload-capable environment is available, use GS Poster's one-time private upload mechanism with **actual source bytes**. Otherwise provide the owner the four verified original files and ask them to select them on the secure GS Poster upload pages. The short-lived bearer upload URLs must never be committed to GitHub or logged publicly. Do not claim an outbound transfer merely because the assistant can inspect images.
4. Confirm all four `upload://` references with `check_upload` or `check_uploads`, matching identity and stored state. Compare stored bytes/digests when independently measurable.
5. Update **existing** draft `p_mvve6u15758e2a8340` to attach four verified images in sequence 1 to 4, and reread to confirm count and order. Keep the Facebook-only target unless the owner authorizes additional platforms. For Bluesky, author image-specific alternative text from inspected visuals, not filename guesses.
6. Request owner editorial review of caption, provisional release name, any genuine Archive/Patreon link, and timing. Keep it an unapproved draft. Only the owner with GitHub sign-in and approval PIN may approve or publish.
7. Update [issue #46](https://github.com/GSGrimoire/gs-poster/issues/46) with the confirmed final result and any remaining blocker.

## Next session, engineering path

**Current release evidence:** GS Poster `main` at `87e94afecc14bf24cf990087cb0713f6ba2dc78c` included the new agent guidance. The production push [Deploy #41115220630](https://github.com/GSGrimoire/gs-poster/actions/runs/41115220630) completed successfully and included a successful Worker deploy. [Live smoke #41115368311](https://github.com/GSGrimoire/gs-poster/actions/runs/41115368311) passed unauthenticated negative checks. Connected `check_setup` reported configured R2 and Bluesky, reachable Facebook, accessible private GitHub staging, no missing secrets. This is not evidence that native ChatGPT file inputs work or that a social draft was posted.

**Highest-priority source:** Native importer [PR #44](https://github.com/GSGrimoire/gs-poster/pull/44) remains **open and unmerged** at `6f1fce72f2f294b544e8318e155e93ecfd08561c`. Source security reviewer recorded **Approved without changes** as a GitHub COMMENT review, not formal GitHub `APPROVED` (both ChatGPT sessions shared the author account). Earlier serious issues were resolved: invalid draft preflight acceptance, corrupt-file readiness, incomplete current-editor revocation checks, and deletion after ambiguous database commits. Its CI checks passed. The connected plugin currently exposes no native `import_chatgpt_files` tool, consistent with it being undeployed.

**Next engineering step:** Check exact PR and main heads, reconcile the doc-only main update, test the integrated head, obtain the required separate-session source review of any changed code and deploy only under the existing production approval gate. Then test real ChatGPT-injected PNG, MP4, ordered four-image carousel, original digest, owner scope, failure/expiry/redirect behavior, and browser fallback. **Do not close issue #32 until genuine original-byte end-to-end acceptance succeeds.**

**Other engineering items:** [#13](https://github.com/GSGrimoire/gs-poster/issues/13) dependency security audit; [#33](https://github.com/GSGrimoire/gs-poster/issues/33) one-page multi-upload and per-platform ordering; [#5](https://github.com/GSGrimoire/gs-poster/issues/5) analytics suggestions blocked on the source feed; [#35](https://github.com/GSGrimoire/gs-poster/issues/35) manual Facebook Groups dispatch; [#34](https://github.com/GSGrimoire/gs-poster/issues/34) Reddit subject to approved access. Do not attempt all work in one session.

## Suggested new-session handoff prompt

> You are **ChatGPT-2 | GS Poster Continuation**. Read `AGENTS.md`, `CLAUDE.md`, `BACKLOG.md` and `docs/HANDOFF_2026-10-30_POSTER_PIPELINE.md` in `GSGrimoire/gs-poster`, plus release issue #46. The previous session located four original winter-cave phased battlemap PNGs in ChatGPT Library, prepared unapproved GS Poster draft `p_mvve6u15758e2a8340`, and recorded exact source hashes. **No images were uploaded.** First check current state and complete the verified four-image private media handoff and draft attachment if supported. Never invent bytes or publish; report any manual upload step needed. Separately triage the reviewed-but-unmerged native importer #44 and dependency audit #13 according to the risk-based review playbook. Record results and next actions on GitHub.
