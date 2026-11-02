# GS Poster handoff: #61 part A, autosave, Post now, earliest valid time, opt-in rollover (2 November 2026)

**Session:** Claude-1 | Implementer. **Branch:** `claude/61-autosave-schedule`. **Base:** `main` `a61f4b7`.
**Owner approval:** issue #61 points 1 to 4 and 6 (Gus, 1 November). Part B (TikTok inline in the same PIN approval, point 5) follows on its own branch, stacked on this one.
**Pull request:** not opened from this session (connector 403). Open from `https://github.com/GSGrimoire/gs-poster/pull/new/claude/61-autosave-schedule`.

## Review depth: Full

Approval route, PIN-gated release time, editor saving, concurrency. No change to the PIN check, lockout, CSRF, same-origin, allowlist, `claimForPublish`, the Facebook queue or any provider call.

## What changed

**Autosave (point 1).** About 1 second after the last edit, the editor sends the same `POST /post/:id/save` form with `X-GS-Autosave: 1`. The server path is unchanged (session, same-origin, CSRF, `expected_updated_at`, `saveEditorDraft` fence, draft-only) and answers JSON `{ok, updated_at}` or `{ok:false, error, current_updated_at}`.
- One save at a time. Edits made while a save is in flight are saved next. The new version is written to every `expected_updated_at` field and to the media panel.
- States: `Unsaved changes`, `Saving...`, `All changes saved`, `Save failed: ...`.
- A 409 (changed elsewhere, or no longer a draft) stops autosave and keeps every edit on the page. A network failure keeps the edits and saves on the next change.
- Approve stays disabled while anything is unsaved.
- When platforms, removed media or the time change, the page reloads after the save, so the release panel lists exactly the saved targets. A partly typed time is never reloaded away (waits for blur).
- Autosave pauses while the uploader is attaching (`window.gsMediaBusy`). The uploader now reads the version on every action.
- The Save button saves immediately through the same path. Without JavaScript the form posts as before.

**Post now (point 2).** Clears the time; the release panel says "Post as soon as you approve". For photo posts it explains the upload queue. A null time is never turned into a schedule, by rollover or anything else.

**Earliest valid time (point 3).** `GET /earliest-time?facebook=&photos=` (signed-in, read-only) uses the **server clock** and `src/schedule.ts`: approval lead plus a 10-minute buffer for reviewing and typing the PIN, rounded up to 5 minutes. **Lead times are unchanged:** 30 minutes for Facebook photo posts, 12 otherwise. Not shortened, because one fast run is not worst-case evidence (#61 point 3). The broken "In 15 minutes" shortcut is gone.

**Opt-in rollover (point 4).** Checkbox `Automatically move to the next valid time if necessary` in the release form, **off by default**, shown only when a time is set. On approval, `decideReleaseTime`:
- A valid time is never moved, and Post now stays now.
- Too close (or passed):
  - not ticked: refused, with the earliest valid time named;
  - ticked: moved to now + lead + 3 min, rounded up to 5 minutes.
- More than 30 days out is refused, never moved.

The moved time goes into `approveAndPublish` and is written by the same version-fenced `claimForPublish` batch, so it is atomic with the approval. Audited as `schedule-rolled-over` with `old -> new`, and shown in the success message.

**Mode clarity (point 6).** The draft editor says "Draft. Changes save automatically. Nothing is published until you approve with your PIN." Scheduled-caption editing (`/edit-caption`) is unchanged and still PIN-protected.

## Tests

`test/autosave-schedule.test.ts` (11, real bundled `handleWeb` in workerd where routes are involved):
- unchanged leads;
- rounding, including across the 25 October Copenhagen daylight-saving change;
- release decisions (Post now kept, valid time kept, refused without opt-in, moved with it, 31 days refused);
- autosave JSON success and stale 409 with nothing lost;
- autosave refused on an approved post, cross-origin, forged CSRF, no session and a non-allowlisted login;
- two simultaneous autosaves from one version: exactly one saved;
- `/earliest-time` needs a session and uses the server clock;
- approval without opt-in refused with a suggestion;
- approval with opt-in: queued photo post, time moved, audit row;
- opt-in never moves a valid time and never helps a wrong PIN or a stale page;
- editor controls present, rollover off by default.

The existing editor test's message match was loosened to the new wording. `npm run check`: 269 of 269. Wrangler dry-run OK.

**Real-browser check** (Playwright against the bundled Worker in Miniflare):
- Typing shows Unsaved and disables Approve; after about 1 second it is saved in D1 and the form version matches the database.
- Turning on Bluesky saves, reloads, and the release panel lists Bluesky.
- Earliest valid time fills 16:00 at 15:19 local for a text post and saves; Post now saves a null time.
- A conflicting change behind the page stops autosave, says why, keeps the text and keeps Approve disabled.
- No script errors.

Approvals in tests use only queued Facebook photo posts (no Graph call in the request) and Bluesky scheduling (no network until cron).

## For the reviewer

- Autosave turns a **rejected** post back into a draft on the first edit, exactly as manual Save always did; Gus's note is kept.
- The reload on structural changes is deliberate. The release panel is server-rendered, and a stale target list could otherwise release fewer platforms than saved.
