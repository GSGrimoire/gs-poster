# Native ChatGPT file-parameter media intake

**Status:** Draft implementation for issue #32. Not verified in the live ChatGPT plugin.

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
