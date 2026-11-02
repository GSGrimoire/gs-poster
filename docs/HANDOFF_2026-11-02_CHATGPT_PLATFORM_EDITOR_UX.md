# GS Poster platform editor usability: implementation handoff

Session: ChatGPT-1 | Implementer
Repository: GSGrimoire/gs-poster
Pull request: #75 (draft)
Base: main (f2920cd86ed24184b16c640621aefea1c3469e7a)
Review depth: **Full review required**, because inactive target persistence and the assistant-facing draft-update tool affect publication eligibility. Same GitHub identity `GSGrimoire` cannot independently approve its own authored change. Do not merge until a different reviewer session or qualified person independently approves the pinned head and the required workflow succeeds.

## User requirements and intended behavior

- Unchecking a platform hides its editing card and readiness indicator but retains its caption, photos, photo order and crop settings. It must never be offered for PIN approval until explicitly reselected and saved.
- TikTok photo-carousel title must be an explicitly authored public title, never the internal GS Poster draft name. Missing titles block photo transfer, but do not block a draft save or a TikTok video.
- Desktop drag-and-drop reorders photos within one selected platform, not across targets; arrows continue to work for keyboard/touch.
- When TikTok is enabled after a Facebook draft exists, the gallery becomes independent; a button permits a one-time replacement with the Facebook photo order. Existing linked Facebook photos remain subject to TikTok's private upload requirement.

## Entry points and security model

1. GET /post/:id renders the editor. Client changes use existing CSRF, same-origin, signed-in and version-fenced save. HTML hidden state now wins over author display styles.
2. POST /post/:id/save invokes parseEditorForm then saveEditorDraft, one D1 batch. TikTok title stored in a new nullable `posts.tiktok_title` column, with idempotent migration. Bluesky/Instagram rows retained with `status='disabled'`. Only unapproved `draft`/`rejected` posts can save.
3. Repository Model Context Protocol `update_draft` calls the same atomic save routine. A null Bluesky/Instagram input now means disable and retain data; omission leaves the current selected state unchanged. `draft_post` and `update_draft` accept a separate TikTok title. Privileged publishing tools remain unavailable to model clients.
4. `getPost` maps disabled Bluesky and Instagram rows exclusively to `bluesky_paused` and `instagram_paused`; `bluesky` and `instagram` are null. Approval, scheduling and cron work with active properties or target statuses, never paused properties. Bluesky cron claims only scheduled targets with prior approval. Instagram remains manual preparation only.
5. TikTok inbox sends via the existing PIN-confirmed exactly-once claim. The new release plan refuses photo transfers without an explicit public title and still requires privately uploaded media; it does not fall back to the internal `label`.
6. Private media preview routes still require signed-in owner access. Saved images for disabled Bluesky are readable only for editing and remain private. Upload ownership and storage readers are otherwise unchanged.

## Failure cases and review focus

- A stale version or approved post must block edits, including reactivation. A failed D1 batch must roll back both post and platform status. An uncertain commit must not be blindly retried.
- A disabled target must neither be offered for approval nor claimed by cron, including a forged request. Re-enabling must restore the same content without publishing it, until the owner separately approves.
- A public TikTok title must be required for photo transfer and must never derive from internal label. The existing TikTok video inbox path is separate and must remain usable.
- Legacy TikTok records with null gallery must be split without accidentally appending TikTok-specific attachments to Facebook, or dropping a shared video.
- TikTok external GitHub image URLs do not satisfy the private-upload requirement. This change does not implement a secure source-file import pipeline and therefore cannot promise that copying a public Facebook link immediately makes it transferable to TikTok.
- Drag reordering cannot add external media, reorder across platforms, bypass form validation, or silently change underlying source URLs. Keyboard arrows remain available.
- Tests using legacy direct saveEditorDraft calls have compatibility defaults; verify all database parameters are defined. Never merge based on source review alone.

## Known limitations and follow-up

The creator's review and GitHub automated checks must be recorded against the final pinned commit. No authenticated production smoke test, live private media conversion, real TikTok transfer or UI device/browser drag test has been performed. The older #74 CSS-only pull request overlaps this feature and should be reconciled before merging either change.

The new PR is **draft**, and no deployment is authorized by this handoff.
