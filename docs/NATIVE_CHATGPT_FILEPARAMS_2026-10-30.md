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
