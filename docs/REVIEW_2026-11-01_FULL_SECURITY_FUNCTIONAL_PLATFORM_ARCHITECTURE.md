# GS Poster: Full security, functionality, and platform architecture review

**Session:** ChatGPT-2 | Independent Reviewer  
**Date:** 1 November 2026  
**Repository:** GSGrimoire/gs-poster  
**Immutable reviewed main:** `3f0c0ffd13653d1876bf53dd0c389426ddce913a` (merge of PR #60)  
**Depth:** Full review, triggered by OAuth and GitHub session authorization, private media, remote transfers, approval, publication, recovery, and cross-platform persistence.  
**Disposition:** **Changes required before enlarging the publishing/approval system.** No finding demonstrates an unauthenticated publish or an approval PIN bypass in the current source. Two concrete draft-integrity defects and a repository governance gap deserve priority. This is a source and CI evidence audit, not a successful live penetration test or a certification of future providers.

## 1. Scope, evidence, and limitations

Read repository `AGENTS.md`, `CLAUDE.md`, Hub `AGENTS.md` and `docs/REVIEW_PLAYBOOK.md`. Inspected the immutable main branch, repository tree, open issues and pull requests, the current production workflow, and the following relevant paths: `src/index.ts`, `web.ts`, `session.ts`, `origin.ts`, `mcp.ts`, `db.ts`, `publish.ts`, `facebook-queue.ts`, `facebook.ts`, `bluesky.ts`, `upload.ts`, `media.ts`, `video.ts`, `chatgpt-native.ts`, `chat-upload.ts`, `github-staging.ts`, `tiktok.ts`, `tiktok-web.ts`, `tiktok-media.ts`, `draft-editor.ts`, `new-draft.ts`, `new-draft-client.ts`, and associated test coverage and design documents. Reviewed current workflow configuration and existing issue #61, issue #33, and issue #13. The deepest line-level inspection was concentrated on security boundaries and draft persistence, rather than independently executing every UI gesture or service combination.

Last verified successful main deployment: [Deploy 41341270993](https://github.com/GSGrimoire/gs-poster/actions/runs/41341270993), checkout `3f0c0ffd13653d1876bf53dd0c389426ddce913a`; check and deploy jobs completed successfully. Exact PR #60 [CI 41340786063](https://github.com/GSGrimoire/gs-poster/actions/runs/41340786063) reported 229 passing tests and successful Wrangler dry-run on the exact PR head in the merge checkout. **No new test process, npm audit, authenticated browser transaction, destructive action, test publication, or provider integration was executed during this review.** Assertions below distinguish direct source defects, hardening opportunities, and requirements for future features.

The GitHub branch endpoint reports `main.protected=false` and the repository rulesets endpoint returned an empty array at review time. This is repo-configuration evidence, not a claim about all possible external organization controls. No workflow or secret was modified.

## 2. Entry-point, authority and threat inventory

| Boundary | Entrypoints | Authority / invariants | Key review result |
| --- | --- | --- | --- |
| Public routing | `src/index.ts`, public legal/health pages, OAuth provider, upload routes | Public requests must not acquire browser editor or approval rights | MCP server and browser approval handler have separate registered paths |
| GitHub browser identity | `/login`, `/callback`, `/authorize`, `src/session.ts` | Signed and expiring session, current login allowlist, consent to a named client | Session checks and allowlist present. Inspect OAuth consent POST defense as a hardening task |
| Browser mutations | `/post/:id/*`, `src/web.ts` | Same-origin, per-session CSRF, version fence as appropriate; privileged actions behind PIN and lockout | PIN control remains before post-level publication, scheduling, cancellation, retries, TikTok transfers |
| No-PIN recovery | `reconcile-stuck`, `redraft` | Allowed session, origin, CSRF, confirmation, version, unchanged SQL eligibility, never publish | Verified in PR #60 full review; not re-executed live |
| MCP tools | `src/mcp.ts` | OAuth current owner, drafts only, no direct publish tools, private-upload ownership | Registered tools have no approval/publish/recovery action; **draft update integrity findings S1 and S2** |
| Private media | `PUT /upload/:id/:token`, `upload://` references, GitHub and native intake | One-use hashed token; size and magic header; owner-scoped readiness; private R2 | Direct protections and native hash/readback checks present; future derivative and leased-hosting design required |
| Background delivery | `scheduled()`, Facebook photo queue, Bluesky due claims | Only previously approved targets; atomic claims; no automatic replay of ambiguous final send | Source enforces approval and the queue's one-way final-send barrier; partial-provider outcomes remain irreducible |
| TikTok | Account connection/settings, post transfer, token refresh, media leases | Provider scopes, encrypted credentials, PIN on post-level transfers | Transfer PIN gates present; account settings have a separate preexisting no-PIN policy |
| CI/deploy | Pull request checks, push-to-main deploy | Reviewed code should be the only source that can reach production | Main has no reported branch protection or repository rulesets: **S3** |

**Threat model:** An unauthenticated outsider, cross-site attacker, malicious or revoked assistant OAuth client, compromised but allowlisted browser session without the owner's PIN, and an authorized editor with stale concurrent forms must not be able to publish unauthorized content, read another editor's private media, overwrite a newer approved snapshot, or cause ambiguous remote sends to replay. Another dimension is human error: an editor must not be shown one target/media variant while a different one is saved or published.

**Existing protections supported by code:** signed 30-day session with live allowlist check (`session.ts:67-80`), CSRF token (`:83-90`), same-origin browser actions (`web.ts:763-768`), PIN presence/lockout/constant-time comparison (`:814-820`), `claimForPublish` transactional draft/version claim (`db.ts:597-626`), scoped private-media checks and pending/stored readiness, and approved-only queue workers. **No assertion of global safety follows from these individual controls.**

## 3. Security and integrity findings, highest first

### S1 | P1 | MCP `update_draft` accepts but fails to persist Facebook selection | Confirmed defect

**Evidence:** `src/mcp.ts:141-155` exposes optional `facebook_enabled`. `:172-181` uses `fbNext` for validation. `:208-225` updates message/media/time but **omits `facebook_enabled: fbNext`** in the main `posts` patch. `:228-230` passes the requested Facebook selection only to `saveBlueskyDraft`, which modifies `bluesky_targets.facebook_enabled`, not `posts.facebook_enabled` (`src/db.ts:513-534`). `get_post` returns the actual unchanged post field (`mcp.ts:55-80`). Approval uses `current.facebook_enabled` (`web.ts:961-968`).

**Reproduction hypothesis grounded in direct code:** Create a combined Facebook/Bluesky unapproved draft with Facebook enabled, call `update_draft({id, facebook_enabled:false})`, then inspect `get_post`; the persisted Facebook enabled flag remains true. An editor may approve an unintended target if the discrepancy goes unnoticed. **PIN protection still applies; this is incorrect target persistence, not a PIN bypass.**

**Correction:** Treat destination selection as an atomic, version-fenced post and platform-target update. Return the saved snapshot, fail if its selected platforms differ, and add an end-to-end MCP regression for enable and disable transitions, including approval-form consistency.

### S2 | P1 | MCP draft edits are not version-fenced or atomic across platforms | Confirmed design defect

**Evidence:** `src/mcp.ts:160-232` loads current draft, performs `updatePost(..., ["draft","rejected"])`, then separately `saveBlueskyDraft` and audit. `src/db.ts:405-417` updates by post ID/status only, **not `updated_at`**, and `:513-535` uses a second database write for Bluesky, also without the loaded version. Browser editor already has a stronger transactional and expected-version pattern in `saveEditorDraft` (`db.ts:481-509`).

**Failure matrix:** (a) Two assistant/browser editors reading the same draft can overwrite one another without stale-version rejection. (b) A post write may commit and the following Bluesky write fail, returning an error after partial success. (c) An audit failure can hide a completed draft change. (d) An approval racing with a save must be proven excluded for both target rows, not inferred from a pre-read. Existing `test/update-draft-security.test.ts` checks invalid media before mutation, not successful concurrent multi-platform save behavior.

**Correction:** Require an expected revision in the MCP contract; use a single conditional transactional batch for main and all targets, check the affected-row counts, and return a confirmed persisted revision. Use monotonically advancing revisions or another robust optimistic-concurrency identifier. Test simultaneous edits, stale request, post-write/response loss, second-statement failure, and approval racing with edit.

### S3 | P1 | Review/merge enforcement is a procedural rather than GitHub-protected boundary | Verified configuration gap

**Evidence:** GitHub returned `main.protected=false`, repository rulesets `[]` on 1 November 2026. `.github/workflows/deploy.yml` deploys from any `main` push after checks and uses a named production environment. Current repository instructions require a separate independent Full review for high-risk changes.

**Consequence:** A credential with write access can potentially push directly to main and activate the deployment workflow without a GitHub-enforced pull request gate, even though team instructions prohibit that. **Production environment reviewer settings were not independently retrieved**, so no assertion is made about an effective deployment approval.

**Correction:** Configure branch rules requiring a PR and required CI status and preventing direct pushes; consider distinct-account review for changes affecting PIN, OAuth, storage or publication. Verify and record production environment approval rules and prohibit unnecessary workflow edits. This is a GitHub administration action, not code to commit from this review.

### S4 | P2 | OAuth consent POST lacks explicit browser origin/CSRF checks | Defense-in-depth review needed

**Evidence:** `src/web.ts:213-272` checks a logged-in session and delegates consent POST to `OAUTH_PROVIDER.approveConsent` / `denyConsent`, without the explicit `sameOrigin` and `checkCsrf` pattern used for the post editor. The provider's consent handle and cookies may enforce equivalent guarantees; this review did **not** establish an exploitable consent forgery.

**Correction:** Verify the dependency's installed consent implementation and write a real callback test for cross-origin form posts, stale handles, consent replay and revoked allowlist. Add explicit origin/CSRF checks when compatible with the provider's protocol.

### S5 | P2 | Generic GitHub media fetch redirect behavior needs a documented security policy | Hardening

**Evidence:** `src/media.ts:89-105` and `src/video.ts:38-51` fetch raw GitHub and (if enabled) authenticated GitHub API content without explicitly specifying `redirect:"manual"`. The more security-conscious private staging and native ChatGPT download paths explicitly reject redirects. This difference matters for future source URL providers and private-repository credentials. **No credential exfiltration was established.** Fetch implementations may strip sensitive headers on cross-origin redirect.

**Correction:** Test redirect behavior and define fixed-host, encoded-path, explicit redirect handling; decide whether a known GitHub content redirect is acceptable only after verifying final destination and that no private header is forwarded. Keep arbitrary HTTP source URLs disallowed.

### S6 | P2 | TikTok account administration is not PIN protected | Existing, owner policy choice

**Evidence:** `src/web.ts:111-113` invokes `tiktokSettingsAction` behind current browser session; `src/tiktok-web.ts:145-200` validates origin/CSRF but does not check `APPROVE_PIN` or lockout for connect, disconnect or hosting the public verification file. Post-level `tiktok-send`, `tiktok-upload`, `tiktok-clear` and `tiktok-status` are PIN protected (`web.ts:814-873`). This difference predates PR #60.

**Risk:** A stolen allowlisted session without the PIN can change TikTok account configuration or disconnect it, but cannot use those settings endpoints to publish. Do **not** silently change this policy without owner approval. See the Asana owner-decision task.

### S7 | P2 | Future Instagram media hosting is a new public/private boundary | Architectural release gate

**Evidence:** The current private `upload://` pipeline cannot simply be passed as Instagram media URLs. The provider fetches media for publication, while GS Poster intentionally keeps its private R2 objects inaccessible. TikTok has time-limited bearer URLs (`src/tiktok-media.ts:27-42,65-114`) as a scoped precedent, not a ready-made Instagram guarantee.

**Requirement:** Treat Instagram hosting as a new high-risk path: publish exact rendered bytes from short-lived, unguessable, content-bound, platform-target-bound leases, narrow MIME types, owner/PIN-approved issuance, expiration, readback, revocation where possible, no redirects, rate limits and no public R2 bucket. Validate any provider-side caching/pull timing, especially scheduled releases. Consider whether issued TikTok leases should be invalidated on explicit transfer cancellation; test against legitimate provider retries.

### S8 | P2 | Dependency security posture needs a fresh classified scan | Unverified

Existing [issue #13](https://github.com/GSGrimoire/gs-poster/issues/13) tracks vulnerability reports. A successful typecheck, test suite and Wrangler bundle dry-run do **not** substitute for a current `npm audit --json`, `npm audit --omit=dev`, lockfile analysis and deployed-bundle reachability review. No new vulnerable-package claim is made here; this audit was not run.

## 4. Functional findings

| ID / priority | Finding and evidence | Recommendation |
| --- | --- | --- |
| F1 / P1 | Saved editor can falsely suggest the crop delivered to a platform. `draft-editor.ts` uses `.tile img {aspect-ratio:4/5; object-fit:cover}` for thumbnail display; it does not transform the original media. | Label thumbnails as preview-only until a real variant is rendered. Preview final transformed bytes in each target column. |
| F2 / P1 | Independent media **selection** exists, but independent per-platform ordering/cropping does not. `new-draft-client.ts:76-94` reorders a common source sequence; the saved editor shows removal and alt editing but no per-platform drag/reorder. Existing [issue #33](https://github.com/GSGrimoire/gs-poster/issues/33) covers part of this. | Platform-specific ordered media lists referencing immutable shared assets; no silent reorder across destinations. |
| F3 / P2 | Saved editor captions are visually stacked: `draft-editor.ts` defines `.caption-grid{display:grid;gap:14px}` without a multi-column template. All platforms and media blocks are vertically stacked in the content column. | Responsive target cards with 2 to 3 side-by-side columns on wide screens and tabs/stacked navigation on mobile. Not one fixed narrow column per every future network. |
| F4 / P1 | The current approval page separates Facebook/Bluesky release from TikTok transfer and has a second `/tiktok-options` route. This conflicts with the **already authorized** one-PIN workflow in [issue #61](https://github.com/GSGrimoire/gs-poster/issues/61). | Implement one saved snapshot and one PIN authorization, with **independent per-platform dispatch states**. TikTok inbox transfer remains an immediate transfer, not automatic publication. |
| F5 / P2 | Draft editor offers `In 15 minutes` (`draft-editor.ts:353-357`), while larger Facebook photo workflows require a longer safe lead. Existing issue #61 records the conflict and the owner-approved opt-in rollover. | Server-computed earliest valid schedule by target and queue condition; never silently change an exact time. |
| F6 / P2 | Internal scheduled/published status can lag provider reality. `mcp.ts:245-254` refreshes scheduled Facebook posts lazily. Read-only production evidence on 1 November showed a known post still `scheduled` internally after its Facebook Page publication appeared. | Explicit per-target reconciliation telemetry, timestamps and `status last checked`, not a single overall post status implying provider certainty. Do not auto-repeat ambiguous sends. |
| F7 / P2 | Source upload retention is 45 days (`upload.ts:5`); a draft, delayed scheduled post or future derivative may outlive the blob. | Media readiness and expiration warnings, last-use/retention policy and preflight immediately before approval and final provider transfer; avoid silent disappearance of originals. |

The present code also has clear strengths: owner-scoped private upload references, native-import persisted-file hash checks, image-count validation for Bluesky, TikTok and Facebook, source-vs-platform selection, reusable upload media, PIN-gated human release, and no MCP publish tool. Preserve these properties.

## 5. Recommended future platform architecture

**Do not add Instagram as another boolean and another gallery inside `posts`.** The current `posts.images`, `tiktok_images`, `bluesky_targets.images`, and top-level `status` model will become fragile with additional platform format differences and partial results.

### Data model

1. **`posts`**: campaign/release identity and optional shared template, no provider-dependent approval status.
2. **`media_assets`**: immutable original private object, owner, verified digest, MIME, dimensions, byte count, retention and provenance.
3. **`media_variants`**: each derived version references an asset plus placement-specific crop rectangle, fit mode, rendered dimensions, encoding and digest. Original never overwritten; variants never silently reused across incompatible formats.
4. **`post_targets`**: one row per platform + account + placement (e.g. Instagram Feed carousel vs Reel) containing caption, hashtags, alt text, media ordered references, provider-specific options, schedule, editable revision, approval snapshot/digest, approval actor/time, state, remote identifiers and error/reconciliation metadata.
5. **`delivery_attempts`**: idempotency/claim IDs, remote ambiguity, attempt lifecycle, per-target result and audit trail. No automatic retries of possibly successful final requests.

Use a reversible, backfilled migration with read compatibility for all existing Facebook/Bluesky/TikTok drafts; specifically maintain the important legacy distinction between `tiktok_images=NULL` (shared fallback) and `[]` (explicit empty gallery). Validate migration on a copy of existing production-shaped rows before live deployment.

### Platform capability and validation registry

Define a versioned capability manifest per **platform + placement + media type**, not one global image limit. It should specify accepted types, width/height/aspect ranges, maximum images, file sizes, caption lengths, alt text/cover requirements, link behavior, queue/scheduling semantics and provider limitations. Apply the **same policy on client preview and server at save, approval and final send**. Data-dependent provider rules and account permissions need live preflight and a documented fallback, not only constants.

- **Facebook**: existing image album and video paths, current 80-image product cap, final Graph scheduling lead and durable photo queue.
- **Bluesky**: maximum four images per post, independent order, descriptions and size policy. Official Bluesky documentation supports up to four with image metadata; verify the active per-blob byte ceiling in the chosen provider path rather than copying a potentially stale third-party number. Reference: https://bsky.network/docs/tutorials/creating-a-post/ .
- **TikTok**: independent photo/video selection and limits, explicit inbox vs direct-post scope, immediate transfer separate from final human posting and calendar timing.
- **Instagram**: distinguish **Feed single image**, **Feed carousel**, **Reel**, and **Story**, as each has different media constraints and app permissions. Exact allowed ratios, recent 3:4 support, quality, formats, carousel count and media pull URL rules **must be validated against the current Meta Content Publishing API for the selected authentication mode**. Typical user-facing presets include square 1:1, portrait 4:5 and suitable landscape, with 9:16 for vertical video placements; do not hard-code these illustrative presets as the full official acceptance range. Official developer reference: https://developers.facebook.com/docs/instagram-platform/content-publishing/ .

### Editing interaction

Use a **shared media library** with original assets at left and a **per-platform target workspace** in the center: desktop has two or three scrollable columns, each with a destination/placement header, caption, current media sequence, cover, crop status, platform validation and a truthful final preview. A review/approval rail at right enumerates release outcomes. With many platforms, show configurable comparison pairs and overflow tabs rather than forcing six unreadable columns. Mobile should use target tabs with a persistent summary and a separate review panel.

The Instagram cropper must support per-image focus and zoom, constrained aspect presets by placement, **crop** or **pad** to preserve artwork, a before/after preview, pixel quality warnings and non-destructive reset. The crop rectangle is normalized to source dimensions and recorded as immutable transformation parameters. The exact rendered variant is privately generated server-side and stored with a digest; client preview alone is not accepted as the deliverable. Strip metadata appropriately, avoid clipping important maps, lettering or borders, and preview carousel order, cover and crop consistency. Other networks can share this derivative service without sharing a forced crop or order.

Caption fields, media lists and warning states belong to their **individual target**. Provide an explicit `Copy from...` action with preview, not implicit cross-platform propagation. Warn before removing a target or changing a crop already PIN-approved.

### Approval and delivery state machine

The owner has **already decided** in issue #61 that one form and one PIN can authorize all selected destinations, with TikTok inbox transfer on the same approval. Implement it as a transaction that freezes a reviewed revision and atomically creates **separately authorized target jobs**. No external requests during draft saving, uploading or a checkbox toggle. A single approval click cannot make external providers atomic: show separate states `draft / approved / queued / transferring / scheduled / published / failed / needs-reconciliation / cancelled` per target. Retries are **per-target**, PIN/lockout-gated, version-fenced, idempotent where providers permit, and never resend after an uncertain final outcome. Show that TikTok inbox transfer is not TikTok publication, and that an Instagram content container is not an Instagram published post. When a target is deselected, revoke its pending authorization without cancelling another target's successful publication.

### Suggested phased implementation

1. **Security remediation and tests:** S1/S2 with real D1 transactional concurrent tests; S3 GitHub rules; classify S4-S8; new CI audit diagnostics. No publication changes.
2. **Domain model:** backward-compatible assets, variants, target rows and revision fences; migration and regression tests over current platform flows.
3. **Editor and preview:** per-target ordering, caption and media editing, 2-column comparison, mobile tabs, crop/pad derivative pipeline; no live Instagram sending.
4. **Unified approval:** implement owner-approved issue #61 semantics with independent target-state handling and fault-injection tests.
5. **Instagram pilot:** choose first placements, obtain minimum-scoped access, validate current Meta specifications and public-media lease; test sandbox/mock and real-owner browser acceptance with **separate explicit approval** before any first actual publication. Do not enable an MCP publish tool.
6. **Provider expansion:** add one adapter/placement at a time with a shared cross-platform contract suite and independent source Full review.

## 6. Acceptance and regression matrix

| Test theme | Required denied or failure cases | Required success evidence |
| --- | --- | --- |
| Identity and consent | Nonallowlisted/expired session, revoked MCP user, cross-site/CSRF, replayed OAuth handles, missing/wrong PIN and lockout | Current owner with valid session, approved scope, explicit target snapshot |
| Draft races | Two edits at same revision, concurrent save/approval, Bluesky second statement failure, ambiguous committed write/audit failure | Exactly one committed revision; no silent lost edit; all targets consistent |
| Target selection | Facebook off after MCP update, Bluesky off, TikTok-only, legacy shared media, target removal while approval in flight | Saved and approved platform set equals editor selection |
| Private media | Foreign owner, expired grant, replay, wrong MIME, truncation, incorrect hash, R2 readback failure, conversion failure | Stored and previewed exact variant digest and correct owner |
| Instagram formats | Overwide, over-tall, small, corrupt, wrong MIME, multi-image mismatch, crop/pad conflict | Provider-validated per-placement dimensions and exact rendered preview |
| Queue/remote ambiguity | Timeout after final send, lost response, duplicate cron, token expiration, partial external acceptance | One durable target outcome; no automatic ambiguous resend |
| Multi-platform | One provider succeeds and second fails, mixed schedule and immediate inbox transfer, cancel one target, stale approval | Each target can be reconciled independently and the UI reports truthfully |
| Browser usability | Desktop 2/3 targets, narrow mobile, keyboard crop controls, zoom, inaccessible touch drag, unsaved changes | Verified visual/live browser interaction, not only HTML string assertions |

## 7. Scope already covered elsewhere

- [Issue #61](https://github.com/GSGrimoire/gs-poster/issues/61): autosave, Post Now, earliest valid schedule, opt-in time rollover and one PIN for TikTok + Facebook/Bluesky, **already approved by owner**. Do not ask owner to re-decide these.
- [Issue #33](https://github.com/GSGrimoire/gs-poster/issues/33): independent gallery order and bulk media.
- [Issue #13](https://github.com/GSGrimoire/gs-poster/issues/13): dependency triage.
- [Platform composer document](PLATFORM_SPECIFIC_COMPOSER_2026-10-29.md): current source-sharing model and legacy compatibility.

Unresolved **owner** choices are restricted to Instagram's first content placements, desired crop/pad defaults, whether to PIN-gate TikTok account administration, and consent to an exact, leased provider-pull media hosting model. Record choices in a single Asana decision task. **No secret values, real owner PIN, live content publication, merge or deployment action formed part of this review.**
