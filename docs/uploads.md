# Private file uploads for GS Poster

The OAuth-protected Model Context Protocol tool `request_upload(filename)` issues a
10-minute, one-use HTTPS PUT link for a JPG, PNG, GIF, or MP4 file. A successful
upload returns a private `upload://<id>.<extension>` reference that can be
used in draft image fields. It is **not** a publication action.

Usage:
1. Call `request_upload` with the file's extension and copy its returned curl command.
2. Replace `<path-to-file>` with an accessible local file path and run it.
3. Check that the response reports `ok: true`.
4. Put the `upload://` reference in `draft_post`, then review and approve
   the post using the existing GitHub sign-in and approval PIN.

### Limits
- One-time bearer link valid for 10 minutes; only a hash of the secret is stored.
- JPG, PNG, GIF up to 10 MiB; MP4 up to 20,000,000 bytes.
- Header signature and exact request-length checks.
- 60 upload links per hour and 3 GiB of stored/reserved uploads.
- Files remain private in Cloudflare R2, with lifecycle deletion after 45 days.
- Old references cannot be used after their object expires.
- The Worker does not provide a public GET download endpoint.

### Required configuration
1. Enable R2 on the Cloudflare account. A payment method may be requested.
2. Give the deployment automation's Cloudflare token **Workers R2 Storage: Edit**.
3. Redeploy. `scripts/prepare-deploy.mjs` creates the bucket and confirms
   the lifecycle rule before enabling the `UPLOADS` R2 binding.
4. Run the OAuth tool `check_setup` and verify `optional.UPLOADS` is true.
5. Perform a real small-file upload and preview test, then verify an actual
   approved publication to the intended test destination.

If R2 is unavailable, upload functionality is disabled, and ordinary drafts
continue to work. The upload URL is secret until use and should not be copied
into public issues, logs, or chat messages. Never send the Cloudflare API token.

**Video integration:** The MP4 upload can be stored on this branch but must
not be offered as a working Bluesky video attachment until pull request #4's
video fetch and validation paths are adapted to read private upload references.

**Review rule:** `UPLOAD_RETENTION_DAYS` in `src/upload.ts` and
`scripts/prepare-deploy.mjs` must be equal. No upload route may publish.
