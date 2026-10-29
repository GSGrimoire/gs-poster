# Platform-specific composition and review

**Updated:** 29 October 2026  
**Scope:** GS Poster new-draft editor, saved draft review, media storage, and TikTok transfer. This is an implemented design in the corresponding pull request, pending validation and deployment.

## Why this was necessary

The previous new-draft workflow incorrectly used the smallest selected platform's image limit as a limit on **all** source images. Adding Bluesky to a TikTok carousel reduced the entire carousel to four images. Facebook and TikTok also shared one `posts.images` array, so it was impossible to use different image selections on the two destinations.

The interface also stacked caption textareas and sometimes hid the TikTok media preview when Facebook was selected, even though the TikTok caption and media could differ.

## Behavior

### Media and copy

- Upload one ordered set of original source images.
- Each source image has independently selectable **Facebook**, **TikTok** and **Bluesky** destinations.
- Defaults: Facebook receives all selected source images, TikTok the first 35, Bluesky the first four. Editors may customize assignments individually. Moving an image up or down changes its relative order within each selected destination.
- Independent limits: **Facebook 80 images, TikTok 35, Bluesky 4**. Bluesky images require separate alt descriptions. Limits apply to each destination, not to the union of selected source files.
- Original media is uploaded to private R2 **once per file**. A single private reference can be assigned to multiple platforms.
- Caption fields appear as platform columns when space permits, with a responsive stacked layout on mobile. Facebook and TikTok captions are separate; Bluesky has its own 300-character caption.
- The saved draft preview also has a distinct image/video/caption section for each selected platform.
- The Facebook/Bluesky approval form is separate from TikTok's PIN-confirmed inbox or private Direct Post flow. Neither draft creation nor platform-selection checkboxes trigger publication.

### Data compatibility

- `posts.images` and `posts.video` remain the canonical Facebook media. Existing Bluesky media and alt text remain in `bluesky_targets`.
- Nullable `posts.tiktok_images` and `posts.tiktok_video` store separate TikTok selections. **A null TikTok image array means a legacy post shares the Facebook gallery**; an empty array means an intentional, independent gallery with zero images. This distinction is essential.
- New web drafts with TikTok selected start with an empty independent TikTok gallery. Older records without this field keep their previous behavior without silent truncation.
- New TikTok video and photo posting paths use the effective TikTok target rather than `posts.images` and `posts.video` unconditionally.
- Existing Model Context Protocol `draft_post` and `update_draft` can supply optional `tiktok_images` and `tiktok_video` for independent media. Otherwise legacy sharing remains available to old clients.
- Media attachments are status- and revision-guarded; rejected or draft posts can change media, while approved posts cannot. Per-target image caps are enforced again in the database transaction.

### Explicit limitations

- The new visual composer still offers one *source content type* at a time: text, image carousel or one MP4. It cannot visually create a Facebook photo album and a different TikTok video in one first-time composition. The underlying saved-draft media actions and connector can represent different media types by platform.
- Changing an already approved Facebook or Bluesky target's media is not supported through this draft form.
- TikTok automatic calendar posting is **not implemented**; selecting a time never sends a TikTok post.
- TikTok `video.upload` and `video.publish` are subject to TikTok account permission, app review and verified media URL requirements.
- This change does not increase private video upload limits or introduce video transcoding, audio editing or new social platforms.
- A multi-image source selection may exceed the one-hour private upload-link quota when very large; the uploader should report the partial saved draft and support resuming, not infer completion.

## Required regression checks

1. Facebook 8 images + TikTok 6 images + Bluesky 4 images in one draft, with independent order and alt text.
2. TikTok-only image or video does not populate Facebook storage or trigger Page publishing.
3. Facebook images and a TikTok video can coexist on a saved draft; each platform sees its own format.
4. Legacy shared TikTok records continue to use their prior gallery.
5. Attempts to exceed Bluesky's four and TikTok's 35-image limits are rejected at the database layer.
6. An unapproved draft is never treated as published; Facebook/Bluesky approval and TikTok transfer require independent PIN actions.
7. Caption edits remain per-platform and cannot modify an already-transferred TikTok payload.
8. Mobile layout stacks platform editors without hiding controls.
9. TikTok URL grant creation reads only that post's effective TikTok images.

## Follow-up work

- Drag to reorder **inside an individual platform** without changing the common source sequence; support different ordering by destination.
- A complete per-platform editor for mixed formats during initial draft creation rather than via saved-draft media editing.
- Per-platform video variations, covers, cropping, short captions and links with appropriate preview.
- Bulk media upload session to handle large Facebook albums and source assets without one request per file.
- Live authenticated browser testing after deployment; passing automated tests alone does not establish that all browser gestures and external platform integrations are working.
