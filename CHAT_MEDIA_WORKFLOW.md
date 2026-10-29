# Send images and videos from Claude or ChatGPT to GS Poster

The GS Poster remote Model Context Protocol (MCP) connection supports private media intake. There is no need to commit social-media images or videos to a GitHub repository.

## What the connector can and cannot see

The connector does **not** automatically receive the binary bytes of every image or video attached to a Claude or ChatGPT conversation. Access depends on which file tools the chat application exposes to the assistant. Never assume that seeing the image in a model conversation means the remote MCP server can read the file.

Two workflows are supported:

### A. Direct transfer when the assistant has file-system or code-execution access

1. In Claude Code or another file-capable environment, ask for `request_upload` with the image or video filename.
2. The tool returns a short-lived `upload_url`, one-time `upload://` reference and a suggested `curl -T` command.
3. Use the environment's file tool to upload the actual bytes, not a text transcript or a rendered description. Example:

   ```sh
   curl --fail-with-body --silent --show-error --upload-file "/path/to/my-image.png" "<one-time upload_url>"
   ```

4. Call `check_upload` using the private reference. It must return `ready: true` before using the media in a post.
5. Call `draft_post` with the media reference, chosen platforms, caption and name. TikTok-only drafts use `facebook_enabled: false`, `tiktok_enabled: true`, no Bluesky target. Facebook/Bluesky can also be selected.
6. Return the draft's `review_url` for inspection. **Never automatically publish.** TikTok transfers require a separate editor action on the GS Poster review page.

A failed or ambiguous upload must not be assumed complete. Check the status first and request a fresh link if the original has been consumed. The existing upload limit is 10 MiB for images and 20,000,000 bytes for MP4 video.

### B. Browser handoff when the chat client cannot read the attachment bytes

This works in Claude's web chat, ChatGPT, and on mobile without depending on model file tooling:

1. Ask your assistant to call `request_upload` for the file.
2. The response contains `upload_page_url`. Open it before its 10-minute expiry.
3. Select the file (or drag and drop) and choose **Upload privately**.
4. The page confirms upload and shows the private `upload://` reference. Return to the chat and say: *"I've uploaded that file. Check it and use it in my GS Poster draft."*
5. The assistant calls `check_upload` and then `draft_post` or `update_draft`.

This involves an explicit file selection in your browser, but requires **no GitHub staging, no command line, and no public media URL**.

## Composer recommendations for Claude

When creating a GS Grimoire product, image carousel, or reel:

- Decide the media order first, and use the uploaded reference for each individual image. A 4-image Bluesky post needs an alternative description for each image.
- Create a descriptive draft caption consistent with GS Grimoire's house rules.
- For Facebook/Bluesky, use their respective options in `draft_post`.
- For TikTok-only drafts, set `tiktok_enabled: true` and `facebook_enabled: false`. TikTok's Web approval page separately offers inbox upload and restricted Direct Post testing.
- The scheduled time entered in a draft is a planner time for TikTok, **not** a TikTok release instruction. TikTok still requires manual transfer approval with a PIN.
- If the assistant lacks file byte access, report that limitation and provide the short-lived upload page instead of promising an automatic transfer.
- Media URLs and references may contain sensitive, temporary credentials. Do not display, log or forward the one-time `upload_url` beyond the editor's private conversation.

## Useful prompt for Claude

> Prepare a GS Poster draft for this GS Grimoire release with the attached images in order. Use the GS Poster connection. If your coding or file tools can access the files, request upload links and transfer the original files to private GS Poster storage, then verify each upload. Otherwise, give me the secure upload pages so I can transfer them directly without GitHub. Once the files are stored, create the draft for my selected platforms and return the review link. Never publish without my approval.

## Security

- OAuth authentication is required to create and check upload links. Only the editor's original account can check readiness.
- The browser upload link contains a high-entropy bearer credential. It expires after 10 minutes and is consumed by one successful upload. Do not share it publicly.
- A secure Content Security Policy limits the browser handoff to same-origin scripts. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Bytes are checked for accepted signatures, maximum size, quota and expiration, then written to private Cloudflare R2.
- Uploaded media is retained under the existing 45-day lifecycle; it is not automatically published.
- GS Poster deliberately does not expose a Model Context Protocol tool that directly publishes content.

## After deployment

The remote MCP connector may require a refresh or reconnection in Claude or ChatGPT to discover the new `check_upload` tool, the `upload_page_url` result and the TikTok draft option.
