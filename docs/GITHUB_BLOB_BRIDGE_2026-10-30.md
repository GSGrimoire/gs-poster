# Private GitHub blob bridge for ChatGPT media
**Date:** 30 October 2026
**Status:** Implemented as a draft-only import tool; production configuration and end-to-end testing outstanding.

## Why this bridge exists
A chat assistant may have access to an original image or video in its execution environment without having an outbound connection to the GS Poster Worker. GitHub's Git Data API can accept original binary bytes as a Base64-encoded blob into a private repository, without adding a file to a branch, commit or pull request. GS Poster can then read that fixed blob from GitHub and store the original bytes in its private Cloudflare R2 bucket.

**Important:** The ChatGPT-to-GitHub step still requires an actual binary-aware way to pass the original file bytes into GitHub's `create_blob` tool. In the connected environment, `create_blob` accepts a Base64 string rather than a native attachment handle. An attachment visible to the model is not sufficient. Do not reconstruct the binary file from a picture or pretend an image was transferred. Textual Base64 transport is an inferior temporary workaround, especially for large or sensitive media.

The GS Poster tool `import_github_blob` solves only the *GitHub-to-private-R2* half, and deliberately has no publishing operation.

## Required one-time setup
1. Create a dedicated **private** GitHub repository, for example `GSGrimoire/GSGrimoire-gs-poster-media-staging`, separate from the public `gs-poster` source repository. Do not stage private media in a public repo.
2. Permit the connected GitHub app to write Git blobs in that private repository using Contents write permission.
3. Create a repository-scoped **read-only** fine-grained GitHub token with Contents read access to this repository only. Set `GITHUB_READ_TOKEN` in Cloudflare Worker secrets. Do not share the token in chat, source files or documentation.
4. Set `GITHUB_STAGING_REPO` to the exact `owner/repo`, e.g. `GSGrimoire/GSGrimoire-gs-poster-media-staging`, as an encrypted Worker **Secret**. Keep both GitHub intake values outside the tracked Wrangler `vars` block.
5. Confirm the GS Poster connector's `check_setup` reports `GITHUB_READ_TOKEN: true` and `GITHUB_STAGING_REPO: true`. These are presence checks only, not proof the name is correct or GitHub is accessible. Then verify with a non-sensitive test PNG before handling real assets.

## Per-file flow
1. Obtain the **original** bytes. Compute SHA-256 of those bytes if supported.
2. Call connected GitHub `create_blob` on the *configured private staging repo* with `encoding: base64` and `content` set to the exact bytes encoded as Base64. GitHub returns a 40-character blob SHA-1 identifier. **Do not commit the blob to any branch.**
3. Call GS Poster `import_github_blob` with `filename`, `blob_sha` and optional `expected_sha256`. The repository is fixed server-side: a chat client cannot supply another repository or arbitrary URL.
4. GS Poster reads the blob through the authenticated GitHub API using the restricted read token, enforcing the 10 MiB JPG/PNG/GIF and 20,000,000-byte MP4 caps, magic bytes, and optional SHA-256 match. It stores bytes using the existing single-use private R2 upload mechanism and returns only an `upload://` reference.
5. Call GS Poster `check_upload` using that reference. Only after `ready: true` use the reference in `draft_post` or `update_draft`. The normal GitHub sign-in and separate PIN approval still govern publication.

## Privacy, retention and failure
- A private GitHub repository is not an ephemeral upload service. Blob data may persist in GitHub object storage or backups. Unreferenced blobs should eventually become unreachable, but there is no guaranteed immediate purge. For stricter disposal, use a dedicated disposable private staging repository and delete that repository after successful confirmed imports and any relevant retention period.
- **Never commit personal/private media to `gs-poster` or any public repository.** Deleting a committed file does not remove it from Git history.
- GS Poster does not delete the source blob automatically. It has no GitHub write token, by design.
- Do not treat GitHub blob SHA-1 as original file SHA-256. Provide the optional SHA-256 only if computed from the original bytes, never guessed.
- A failed import is not a verified upload. The importer returns no `upload://` reference until the private R2 storage operation succeeds. Retry with the same blob SHA if needed.
- The importer does not create a draft, approve a post or publish to Facebook, TikTok or Bluesky.
- If the chat cannot send binary bytes to the GitHub connector, fall back to the existing private browser upload page. Native no-click end-to-end transfer remains open in issue #32.

## Validation before marking issue #32 complete
- Verify a real ChatGPT-generated PNG can be passed as original bytes into the GitHub create_blob tool without hand-copying megabytes of Base64.
- Confirm a private GitHub API download returns the same SHA-256, importer yields `upload://`, and `check_upload` returns stored.
- Test a MP4 under the 20,000,000-byte cap and rejection of unsupported and oversized inputs.
- Confirm media remains usable from GS Poster even after the GitHub staging source is no longer available.
- Verify that all of these steps remain draft-only and preserve existing PIN-gated approval.
