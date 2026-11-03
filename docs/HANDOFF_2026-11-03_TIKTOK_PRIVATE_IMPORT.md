# TikTok linked GitHub image preparation: Full-review packet

Role: ChatGPT-1 | Implementer, GitHub identity `GSGrimoire`
Pull request: #76
Base: `main` (post-#75)
Review depth: **Full**, mandatory because this moves external GitHub bytes into private R2, adds a signed-in write endpoint, verifies object integrity and mutates draft media.
Status: implementation and author tests; requires independent source security review at the **final pinned PR head**, and production validation after merge. Do not merge this draft PR on the strength of automated tests alone.

## Feature and entry points

A saved Facebook draft can be switched on for TikTok, creating an independent copy of the Facebook photo references. A new button in TikTok's editor card prepares only externally linked GitHub images. The signed-in page calls `POST /post/:id/import-tiktok-image`, once per image index, sequentially. It sends only index, anti-forgery token and saved post version; arbitrary URL or upload reference supplied by the caller is ignored. The target photo is selected server-side from that post's saved `tiktok_images` array.

This route shares the existing `draftImageAction` session gate, same-origin check, anti-forgery token, unapproved draft/rejected state check and audit. A second guard in `importTikTokLinkedImage` checks the exact revision, selected TikTok target, independent image array, no TikTok video and GitHub-only source. No publishing or transfer function is called. The Model Context Protocol draft tool remains separate and cannot invoke the import endpoint or approve a post.

## Trust and media flow

1. Browser: authenticated owner-controlled action; no external URL input. An unsaved editor or currently busy uploader blocks the action.
2. Source: existing stored TikTok gallery URL only, GitHub raw/blob URL parsed by `src/media.ts`. Outbound requests start at `raw.githubusercontent.com` or `api.github.com`; the existing image-fetch helper follows HTTP redirects, which is an explicit independent-review item. Private GitHub repositories may use the configured server-side read token. No arbitrary external host is accepted as an input.
3. Download: 10 megabyte maximum by declared length and bounded response stream; JPG, PNG or GIF file extension and magic-byte check. Reject empty/bad/oversized images. No public storage occurs here.
4. Private persistence: use existing `createUpload` for quota, identity, one-time token and expiration, then `handleUploadPut` for the one-use claim, R2 write, signature check and finalization. A verify hook reads private R2 bytes back and checks length and SHA-256 against the downloaded bytes **before** the DB row transitions to `stored`. These checks establish downloaded-to-stored fidelity, not an independent hash of the upstream original asset.
5. Draft attachment: `replaceTikTokDraftImage` updates exactly one `tiktok_images[index]` with the `upload://` reference, guarded by draft status, no approval, selected TikTok, exact version, original URL at that index, independent gallery and no TikTok video. It does not mutate `images` (Facebook), Bluesky, Instagram or the release state.
6. Existing TikTok release mechanism: signed-in owner/PIN approval and claimed transfer are unchanged. `src/tiktok-media.ts` serves only temporary individually hashed TikTok pull grants, converting privately read image bytes to WebP. Raw private R2 objects remain inaccessible publicly.

## State and failure matrix

- Unauthenticated, cross-origin, invalid anti-forgery token: stop before reading post or fetching any GitHub source.
- Bad index, unselected platform, legacy shared gallery, changed version, published/approved post, unsupported URL: stop before any download or new upload grant.
- GitHub fetch error, empty or oversized stream, spoofed signature: do not reserve a private object or edit draft.
- Quota or R2 write rejection: upload not attached. A write with uncertain acknowledgment consumes its one-time grant; do not replay. Verified-but-unattached private images may remain until existing 45-day storage lifecycle.
- R2 readback differs from downloaded bytes: upload never marked `stored`; best-effort removal may occur before finalization is attempted, under the existing upload-path rules.
- D1 finalize result is uncertain after successful R2 write: do not delete or retry; return uncertainty and require the owner to refresh and inspect.
- Source index or revision changes during a download: version/source compare-and-swap prevents attaching to a different gallery or already approved post. The successful private upload may be orphaned until retention expires.
- Partial multi-image batch: prior completed private references remain in the TikTok gallery, later original references remain unchanged, Facebook stays intact. Browser shows partial failure and requires refresh.
- Expiry: private images are deleted under the existing 45-day R2 lifecycle. The original GitHub references remain in Facebook; owner may recopy and prepare again before transfer.

## Tests and limitations

`test/tiktok-import.test.ts` exercises production Worker request path with Miniflare (sign-in, cross-site and forged anti-forgery denial; index and URL controls; R2 readiness/readback; ordered replacement; no Facebook mutation; invalid or oversized GitHub response; selected target; approved draft; partial batch; race/stale version; duplicate import). Extra in-process tests exercise corrupt R2 readback and a concurrent update between download and attach. Existing `npm run check` and `npx wrangler deploy --dry-run --outdir dist` must pass at the final head.

No real GitHub private-repository token access, actual Cloudflare Images conversion, live R2 production integrity, deployed browser drag/stream behavior or TikTok inbox acceptance has yet been tested. Independently measured upstream-original file hashes are not available. A separate reviewer must validate this entire affected path and the unchanged `src/upload.ts`, `src/tiktok-media.ts`, `src/tiktok-posting.ts`, `src/web.ts` authentication gate and `src/db.ts` approval invariants. This source review does not authorize a real TikTok send.

## Reviewer disposition requested

Review actual final PR head and audit it as `ChatGPT-2 | Independent Reviewer` or qualified human, with real GitHub identity and exact commit. Check redirects, owner revocation, one-use upload side effects, integrity failure and cleanup, quota accounting, race behavior, stored-media readers, ambiguity and no-publish guarantees. Report **Approved without changes** or consolidated **Changes required**. No implementer-authored approval counts as independent review.
