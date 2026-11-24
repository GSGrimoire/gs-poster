# GS Poster guided multi-platform Studio, implementation handoff

Session: **ChatGPT-1 | Implementer**  
Date: 19 November 2026  
Review depth: **Full review**  
Base: `main` at `90b572402375353ef763174d824c34bebc23eaec`  
Branch: `chatgpt/guided-platform-studio-20261119`  
Final head: the reviewer must retrieve and pin the current branch head from GitHub.  
Status: **Unmerged, undeployed. No production drafts changed.**

## Owner goal and design

Show Facebook, Instagram, Bluesky and TikTok **simultaneously as horizontal platform rows**. Inactive destinations remain visibly greyed out; their checked state is the sole existing platform enable/disable form value. Rows summarize media count, caption excerpt, a preparation or release issue, and a link to the detailed editor. The existing editor cards remain in a one-column vertical layout for readable correction of platform-specific fields. Do not interpret an inactive platform as an approved target.

A first-time enable of Bluesky or Instagram selects already-attached post photos automatically without copying private bytes. Bluesky initially selects up to four photos and leaves alternative text blank for owner review; Instagram initially selects up to ten photos with *pad* mode, avoiding unexpected cropping. TikTok's existing Facebook-gallery inheritance is preserved, and first activation can also inherit another platform's photos or video when the Facebook gallery is empty. Explicitly customized or paused Bluesky and Instagram galleries are retained and not overwritten. A legacy shared TikTok gallery is separated into independent media on editor save. Existing TikTok independent galleries remain independent.

The overview now checks missing TikTok photo titles in addition to its media and caption rules. The status distinguishes media preparation, release issues, manual Instagram delivery and selected-but-empty gallery review. It does not claim that a remote platform accepted the post. Unsaved edits still disable the release button until the save finishes.

## Affected entry points and trust model

| Entry | What is changed / relied upon |
| --- | --- |
| `GET /post/:id` via `postPage` and `renderDraftEditor` | Owner-authenticated review, inert platform rows and captions, server-rendered status |
| `GET /draft-editor.js` | Client state refresh, overview activation and readiness checks; no publishing calls |
| `POST /post/:id/save` via `parseEditorForm` and `saveEditorDraft` | First-activation media reference selection, authenticated/same-origin/CSRF/version fenced, unapproved state only |
| `GET /media/:id/:index` and Instagram preview | Existing authenticated media access; no new public read routes |
| `POST /post/:id/approve` and TikTok inbox transfer | Unchanged PIN-gated publication path; review entire approval readiness to ensure no bypass |
| `draft_post`, `update_draft`, `attachDraftImage`, `attachDraftVideo` | Unchanged tools and attachment routes; verify media provenance and legacy gallery semantics |

All automatic media selections are resolved server-side from existing `postPhotos(cur)` or `postVideos(cur)`, not user-provided arbitrary URLs. The current post is the only source of media. In the Bluesky manual-copy path, browser-provided indices remain bounded and resolved against the server's post pool.

## Security invariants and failure states

1. Selecting a platform or autosaving **never approves, transfers, publishes or schedules**. Only unapproved drafts/rejected posts may be saved.
2. The signed-in allowlist, CSRF, same-origin, optimistic version check, PIN and lockout are not changed.
3. Existing customized Bluesky and Instagram galleries are not silently replaced by first-activation defaults. TikTok's independent gallery is not replaced by activation alone.
4. Each target has its own media count limit. First inheritance selects at most Bluesky 4, Instagram 10 and TikTok 35. Media remain source references and are never reuploaded during selection.
5. Bluesky inherits **empty** alternative text intentionally: `checkBluesky` must refuse a release until descriptions have been supplied. Instagram uses owner-reviewable pad/crop settings.
6. TikTok remote transfer still requires a public carousel title, private-media preparation when applicable, the account permission and the owner's approval PIN.
7. Concurrent or stale editor saves still use the existing atomic version fence. A failed save must not silently approve or modify the newer saved state.
8. The all-platform overview uses escaped labels, captions and reason strings; no private media object reference is shown to the browser beyond existing same-origin proxy routes.
9. A failed or uncertain platform release must not be retried by toggling a platform or saving the draft.

Failure scenarios for review: large source galleries, no media, video-only posts, old shared TikTok records, intentionally empty/paused independent targets, missing title and alternative text, stale client version, simultaneous tab saves, disconnected TikTok or Instagram, failed autosave/reload, external media preparation failure, and partial target approval.

## Added tests and commands

- `test/draft-editor.test.ts`: actual authenticated saved-draft route for first-time multi-platform inheritance; alternative text remains blank; Instagram pads; saved state is still unapproved. TikTok can inherit from Bluesky if Facebook has no gallery.
- `test/platform-targets.test.ts`: shared TikTok title readiness, inactive horizontal rows, edit links and client interaction plumbing.

Commands required before approval:

```sh
npm ci
npm run check
npx wrangler deploy --dry-run --outdir dist
```

**Not executed by the implementer in this environment.** The GitHub connector permits source edits, but the local runtime cannot resolve github.com or clone the repository, and local dependencies are unavailable. The account's GitHub Actions hold through 30 November 2026 also prevents using remote continuous integration as a substitute. Automated test results are **unknown**, not passed. A separate session must independently inspect the current branch head and execute feasible checks before approval.

## Explicit limitations and independent-review questions

- Platform overview is not a new multi-step wizard. It gives one persistent row and the highest-priority issue per platform; the existing detailed editor performs corrections. Further usability refinements may be needed after browser testing.
- The first-selection cap is visible as a review note, but a large source gallery still requires manual selection of the desired subset.
- An intentionally empty Facebook gallery has no separate first-initialization marker, so Facebook is not automatically repopulated from another platform. This is a known scope limit.
- Automated caption rewriting, accessible alternative-text generation, new image transformations, account connection, publication automation and data migrations are out of scope.
- Browser interaction on desktop and mobile, especially autosave/reload and all-platform status reconciliation, has **not** been validated in a real signed-in browser.
- Review parity of server `checkTarget`, client `checkTarget`, actual release checks (`checkBluesky`, `tiktokReleasePlan`, `instagramReleasePlan`) and form validation. Check that no new status suggests publication is guaranteed.
- Review unchanged `saveEditorDraft`, `getPost`, existing media-owner validation, and approval handlers for preservation of authority and old data.
- Do not merge or deploy before separate ChatGPT-2 independent full review at the exact final commit, all mandatory tests, and the current no-merge hold ending 1 December 2026. The shared GitHub login is not formal independent account approval.
