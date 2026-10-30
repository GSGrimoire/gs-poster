# Native ChatGPT file-parameter media intake

**Status:** Security remediation in progress following independent review of PR #44. No production approval; no live ChatGPT transfer verified.

## Supported mechanism

OpenAI documents top-level file arguments named under the MCP tool descriptor metadata
openai/fileParams. Each input is a file object containing required download_url and
file_id and optional mime_type / file_name. Arrays of files are supported.
Official reference: https://developers.openai.com/plugins/reference#file-apis

The new GS Poster tool import_chatgpt_files accepts a file array and stores the
original bytes as owner-scoped upload:// references.
It does **not** create, approve, schedule or publish posts.

## Trust boundaries and limitations

- Only authenticated, existing GS Poster editors may call this draft-media tool.
- download_url is a short-lived bearer address and is never included in returned
  metadata, GitHub commits, application logs, or draft content.
- The importer restricts downloads to HTTPS files.oaiusercontent.com, without
  credentials, redirects, referrers or cookies. This is a conservative allowlist,
  not proof that every ChatGPT client always uses this host. If the provider
  uses a different origin, investigate the genuine host before extending the
  allowlist, rather than accepting arbitrary URLs.
- file_id is required by the file parameter adapter but is not an independent
  cryptographic authorization proof. The authenticated tool call, host file
  selection and provider-origin allowlist are distinct controls.
- Each file must have an allowed extension or matching declared MIME type.
  The original binary is bounded as it streams into the Worker (10 MiB for JPG,
  PNG and GIF, 20,000,000 bytes for MP4), checked against file magic and hashed
  with SHA-256 before any private upload is reserved.
- Existing one-time upload, quota, retention, owner-readiness and R2 writing
  handlers are reused unchanged. The result preserves the supplied file order.
- If the first unimportable file is reached, the tool reports partial results
  and requires explicit browser fallback for the missing files. It never
  reports successful storage for files it did not receive.
- ChatGPT mobile and some plugin contexts may expose file references
  differently or not at all. Do not close issue #32 on schema/unit tests alone.
  Existing request_uploads private browser pages remain supported.

## Required live acceptance before completing issue #32

1. Deploy the new Worker code and refresh/reconnect the ChatGPT GS Poster plugin
   so import_chatgpt_files is exposed.
2. Attach a fresh PNG and MP4 directly in ChatGPT and call this tool with actual
   host-provided file parameters, without manually typing URL or base64.
3. Confirm the provider-supplied URL hostname matches the allowed origin.
   Never paste or log the temporary signed URL.
4. Verify each returned upload:// reference with check_uploads, owner match
   and original byte hash (measured outside model context).
5. Confirm a user-approved draft uses the references in the requested order.
6. Confirm failed/oversized/redirected files, cross-owner references, expired
   access and clients lacking fileParams use the secure browser fallback.
7. Confirm no publication occurs without the separate existing approval PIN.

The GitHub staging bridge remains an optional compatibility path only. Native
fileParams transfer is intended to eliminate it from the ordinary chat upload flow.


## Security remediation after independent review of PR #44

**[ChatGPT implementation session | 30 October 2026]**
Changes are proposed on the same feature branch for renewed independent review; they are not security approval or proof of operational native intake.

- **SEC-1:** Every private `upload://` image and video reference is checked for `stored` status and ownership against the currently authenticated editor before `draft_post` or `update_draft` performs media reads, including Facebook, TikTok and Bluesky fields beyond the first eight media preflight entries. This does not relax web approval.
- **SEC-2:** A declared Content-Length must match bytes received, container completion checks reject visibly truncated PNG/JPEG/GIF/MP4 media, and R2 bytes are read back and independently hashed against the received stream before a confirmed import is returned. The returned SHA-256 authenticates the **received and persisted bytes**, not independently the original user-selected file. Live source-file comparison remains required.
- **SEC-3:** Stored references are appended to batch results before auditing. An audit failure stops further imports but preserves a confirmed file reference. Ambiguous upload status returns an owner-checkable recovery reference instead of silently suggesting a duplicate import.
- **SEC-4:** OAuth media-import and draft entry points recheck the currently configured allowed-GitHub-editor list, including already issued tokens. The web approval policy remains separate.

The real-file acceptance gate remains blocked until the independent reviewer reexamines all fixes and tests, and a test environment proves image, video, three-file order, ownership isolation, expiry/redirect rejection and browser fallback.


## Independent re-review findings R1 and R2: revision

**[ChatGPT implementation session | 30 October 2026, implementation notes]**
The second independent security review of commit `5086008` requested two further fixes. This section records implementation changes, **not** reviewer approval.

- **R1 (draft update validation):** `update_draft` now adds new Facebook image and Bluesky image validation errors directly to the final `errors` array before any `updatePost` or `saveBlueskyDraft` mutation. Existing TikTok preflight failures also feed that array. The actual handler is exported through `handleUpdateDraft` and exercised in regression tests for arbitrary host, malformed private reference, failed image read, Bluesky image and TikTok image. Invalid updates must leave draft data unchanged.
- **R2 (storage readiness):** The native file importer now passes a private readback-verification callback to the existing one-time upload handler. The callback checks R2 object byte length and SHA-256 **before** the database transitions from `uploading` to `stored`. If storage readback fails or bytes mismatch, the handler keeps the record non-ready and makes a best-effort attempt to delete the unique R2 object. Even if cleanup fails, owner-bound `check_upload`, `check_uploads`, and `update_draft` reject the reference because status never becomes `stored`. An `unconfirmed` recovery reference is diagnostic information, not authorization to use the file.
- New regression coverage passes deliberate R2 corruption through the real `check_upload` readiness implementation, batch checks, and attempted draft update, asserting that the private media never becomes ready or draft-attachable. First-time schema migrations are not counted as draft mutations in the handler tests.
- Ordinary browser uploads and GitHub blob ingestion continue using the existing handler without the native prefinalization option. No publishing consent or approval PIN changes are part of this revision.

**Release gate:** Do not merge or deploy this unapproved branch until the independent reviewer explicitly re-reviews the new commit and records a decision. Synthetic regression tests alone do not prove original file transfer. Live, host-provided attachments and independently measured original SHA-256 hashes remain mandatory before issue #32 can be closed.


## Independent security re-review findings R3 and R4

**[ChatGPT implementation session | 30 October 2026]** The third review of commit `a2504f6` required two additional corrections. This section documents implementation, **not independent approval**.

- **R3, revoked OAuth editor credentials:** All 14 registered Model Context Protocol tools now enforce `currentOwner(env)` or delegate to an authenticated handler before database access or external API requests. Specifically, `delete_draft`, `list_posts`, `get_post`, `list_page_posts`, `check_setup`, and `check_upload_usage` were brought under the current allowlist. The destructive and private-post reading handlers are exported for focused tests, with a previously authorized editor removed from `ALLOWED_GITHUB_LOGINS`. Tests ensure no database access occurs, and a registration-inventory test flags any newly added tool without an explicit allowlist gate.
- **R4, database acknowledgment ambiguity:** Private object verification completes before the database's `stored` transition. If verification fails before the transition is attempted, the object is eligible for best-effort cleanup and never becomes draft-ready. After finalization is **attempted**, neither database errors nor missing acknowledgments authorize deleting an already verified private object. The one-use upload token remains consumed, and the caller receives an unconfirmed recovery reference. A targeted regression simulates a database update that commits `stored` but throws before returning; the test verifies the object still exists with the original SHA-256 and the owner readiness checks remain consistent. A noncommitting finalization remains non-ready and does not reopen the token.

**Release gate remains unchanged:** Independent re-review of the new exact head is required before merging, followed by deployment and real ChatGPT attachment tests with independent original-file hashes. No publishing PIN or approval controls were changed.
