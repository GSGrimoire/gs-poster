/**
 * The tools Claude gets. There is deliberately no publish tool: drafts only go
 * live when Gus approves them on the approval site with his PIN.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env.ts";
import { missingSecrets } from "./env.ts";
import { audit, createPost, deletePost, getPost, listPosts, updatePost, type Post, type PostStatus, type BlueskyDraft, saveBlueskyDraft } from "./db.ts";
import { checkPage, listPagePosts } from "./facebook.ts";
import { checkBluesky } from "./bluesky.ts";
import { checkVideoUrl } from "./video.ts";
import { checkImageUrl, fetchImage } from "./media.ts";
import { importStagedGitHubBlob, verifyPrivateStagingRepo } from "./github-staging.ts";
import { importChatGPTFile } from "./chatgpt-native.ts";
import {runNativeBatch} from "./native-batch.ts";
import {checkOwnedDraftMedia,isCurrentEditor} from "./media-owner.ts";
import { refreshScheduled } from "./publish.ts";
import { formatLocal, parseWhen } from "./time.ts";
import { checkMessage, checkWhen, DRAFT_MIN_LEAD_MS, MAX_IMAGES } from "./validate.ts";
import { createUpload, getUploadUsage, uploadStatusForOwner } from "./upload.ts";
import {createChatUploadBatch,checkChatUploadBatch,CHAT_BATCH_MAX_FILES,CHAT_BATCH_CHECK_MAX} from "./chat-media.ts";

const STATUSES = ["draft", "rejected", "publishing", "scheduled", "published", "failed", "cancelled"] as const;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, extra?: Record<string, unknown>) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }] };
}

function ownerLogin():string {
  const login=getMcpAuthContext()?.props?.login;
  return typeof login==="string" ? login : "";
}
/** Issued OAuth tokens must still match the CURRENT editor allowlist. */
function currentOwner(env:Env):string{
  const login=ownerLogin();
  return isCurrentEditor(env,login)?login:"";
}
function actor(): string {
  const props = getMcpAuthContext()?.props;
  const login = typeof props?.login === "string" ? props.login : "unknown";
  // The human-approved OAuth client name is stored in access-token props.
  // Older connections remain unidentified until they reconnect.
  const client = typeof props?.clientName === "string" && props.clientName.trim()
    ? props.clientName.trim().slice(0, 80) : "MCP client (unidentified)";
  const domain = typeof props?.clientDomain === "string" && props.clientDomain.trim()
    ? props.clientDomain.trim().slice(0, 120) : "no verified domain";
  return `${client} [client name self-declared; ${domain}] (via ${login})`;
}

function view(env: Env, origin: string, p: Post) {
  return {
    id: p.id,
    status: p.status,
    label: p.label,
    release: p.release,
    message: p.message,
    tiktok_caption: p.tiktok_caption,
    images: p.images,
    tiktok_images:p.tiktok_images,
    tiktok_video:p.tiktok_video,
    video: p.video,
    facebook_enabled: p.facebook_enabled,
    tiktok_enabled: p.tiktok_enabled===true,
    bluesky: p.bluesky,
    link: p.link,
    publish_at: p.scheduled_at,
    publish_at_local: p.scheduled_at ? formatLocal(new Date(p.scheduled_at), env.TIMEZONE) : "on approval",
    review_url: `${origin}/post/${p.id}`,
    facebook_post_id: p.fb_post_id,
    permalink: p.permalink,
    gus_note: p.note,
    error: p.error,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

async function checkImages(env: Env, urls: string[]): Promise<string[]> {
  const errors: string[] = [];
  if (urls.length > MAX_IMAGES) errors.push(`At most ${MAX_IMAGES} images per post.`);
  // Validate every source, but fetch no more than eight media files per request.
  // The approved queue checks remaining files in batches without exceeding
  // the Worker free-plan subrequest budget.
  for (const [index, u] of urls.entries()) {
    const bad = checkImageUrl(u);
    if (bad) {
      errors.push(bad);
      continue;
    }
    if (index >= 8) continue;
    try {
      await fetchImage(env, u);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return errors;
}

function readWhen(env: Env, input: string | null | undefined): { when: Date | null; error?: string } {
  if (input == null || input === "") return { when: null };
  try {
    const when = parseWhen(input, env.TIMEZONE);
    const err = checkWhen(when, new Date(), DRAFT_MIN_LEAD_MS);
    return err ? { when, error: err } : { when };
  } catch (e) {
    return { when: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const imageList = z
  .array(z.string().min(1))
  .max(MAX_IMAGES)
  .describe(
    "Image URLs in display order. Use upload:// references from request_upload, or raw.githubusercontent.com links (e.g. from the GS Grimoire image library) or github.com/.../blob/... links. JPG, PNG or GIF, max 10 MB each. Up to 80 Facebook photos are uploaded in safe eight-photo batches after approval.",
  );


const blueskySchema = z.object({
  caption: z.string().describe("Bluesky-specific caption, maximum 300 grapheme characters."),
  images: z.array(z.object({
    url: z.string().min(1).describe("GitHub file URL or upload:// reference from request_upload."),
    alt: z.string().describe("Human-readable alternative text derived from the image library description, not a filename guess."),
  })).max(4).default([]),
  video: z.object({
    url: z.string().min(1).describe("GitHub MP4 URL or private upload:// MP4 reference (up to 20 MB)."),
    alt: z.string().min(1).describe("Accessibility description for this video."),
  }).nullable().optional(),
  patreon: z.object({
    url: z.string().url().describe("Public/free Patreon post URL under patreon.com/posts/."),
    title: z.string().min(1).describe("Link-card title for the free Patreon post."),
    description: z.string().min(1).describe("Link-card description."),
  }).nullable().default(null),
});

const updateDraftSchema = z.object({
        id: z.string(),
        message: z.string().max(63206).optional(),
        tiktok_caption:z.string().max(4000).nullable().optional().describe("Separate TikTok caption. Null removes override; otherwise can contain hashtags. TikTok video limit 2,200, photo limit 4,000 characters."),
        facebook_enabled: z.boolean().optional(),
        bluesky: blueskySchema.nullable().optional(),
        images: imageList.optional(),
        tiktok_images:imageList.nullable().optional().describe("Independent TikTok carousel; null restores shared fallback."),
        tiktok_video:z.string().nullable().optional().describe("Independent TikTok video or null."),
        video: z.string().nullable().optional().describe("Facebook MP4 reference, or null to clear it."),
        link: z.string().url().nullable().optional(),
        publish_at: z.string().nullable().optional(),
        label: z.string().max(120).optional(),
        release: z.string().max(120).optional(),
      });

/** Actual update_draft handler. Exported so regression tests exercise the same
 * database-mutation boundary as the MCP tool, with an injected editor identity.
 */
export async function handleUpdateDraft(
  env:Env,origin:string,login:string,input:z.infer<typeof updateDraftSchema>,
){
  const {id, message, tiktok_caption, images,tiktok_images,tiktok_video,video, link, publish_at, label, release, facebook_enabled, bluesky}=input;
      if(!login)return fail("Editor access is no longer authorized.");
      const cur = await getPost(env.DB, id);
      if (!cur) return fail(`No post with id ${id}.`);
      if (cur.status !== "draft" && cur.status !== "rejected") return fail(`This post is ${cur.status}; only drafts and rejected posts can be changed.`);
      const nextMessage = message ?? cur.message;
      const nextImages = images ?? cur.images;
      const nextVideo = video === undefined ? cur.video : video;
      const time = publish_at === undefined ? { when: cur.scheduled_at ? new Date(cur.scheduled_at) : null } : readWhen(env, publish_at);
      const bsNext: BlueskyDraft | null = bluesky === undefined ? cur.bluesky : bluesky;
      const fbNext = facebook_enabled ?? cur.facebook_enabled;
      const checks=fbNext?checkMessage(nextMessage,{hasImages:nextImages.length>0||!!nextVideo}):
        cur.tiktok_enabled?checkMessage(tiktok_caption??cur.tiktok_caption??nextMessage,{
          hasImages:(tiktok_images??cur.tiktok_images??nextImages).length>0||!!(tiktok_video??cur.tiktok_video??nextVideo)
        }):{errors:[],warnings:[]};
      const bsHouse = bsNext ? checkMessage(bsNext.caption, { hasImages: bsNext.images.length > 0 }) : null;
      const bsErrors = bsNext ? [...checkBluesky(bsNext), ...bsHouse!.errors] : [];
      const errors = [...checks.errors, ...("error" in time && time.error ? [time.error] : []), ...bsErrors];
      if (!fbNext && !bsNext && !cur.tiktok_enabled) errors.push("Select at least one of Facebook, Bluesky or TikTok.");
      const nextTTImages=tiktok_images===undefined?(tiktok_video?[]:cur.tiktok_images):tiktok_images;
      const nextTTVideo=tiktok_video===undefined?cur.tiktok_video:tiktok_video;
      const privateErrors=await checkOwnedDraftMedia(env,login,[
        ...nextImages,...(nextTTImages??[]),...(nextVideo?[nextVideo]:[]),
        ...(nextTTVideo?[nextTTVideo]:[]),
        ...(bsNext?.images.map(i=>i.url)??[]),
        ...(bsNext?.video?[bsNext.video.url]:[]),
      ]);
      if(privateErrors.length)return fail("Draft media access denied.",{problems:privateErrors});
      // All media preflight errors must be added to the final error collection
      // BEFORE updatePost can run. Do not mutate arrays already spread into it.
      if(images)errors.push(...(await checkImages(env,images)));
      if(bluesky&&bsNext)errors.push(...(await checkImages(env,bsNext.images.map(i=>i.url))));
      if (cur.tiktok_enabled && (nextTTImages??nextImages).length > 35) errors.push("TikTok carousels support at most 35 images.");
      if (tiktok_images!==undefined&&!cur.tiktok_enabled)errors.push("TikTok gallery requires TikTok target.");
      if (tiktok_video!==undefined&&!cur.tiktok_enabled)errors.push("TikTok video requires TikTok target.");
      if (nextTTVideo&&(nextTTImages??nextImages).length)errors.push("TikTok photos and video cannot be combined.");
      if (nextTTVideo&&checkVideoUrl(nextTTVideo))errors.push(checkVideoUrl(nextTTVideo)!);
      if (tiktok_images?.length)errors.push(...(await checkImages(env,tiktok_images)));
      if (nextVideo && !fbNext && !cur.tiktok_enabled) errors.push("A video requires Facebook or TikTok.");
      const nextTikTokCaption=tiktok_caption===undefined?cur.tiktok_caption:tiktok_caption;
      if(tiktok_caption!==undefined && !cur.tiktok_enabled) errors.push("TikTok caption requires the TikTok target.");
      if(cur.tiktok_enabled && (nextTikTokCaption ?? nextMessage).length>((nextTTImages===null?nextVideo:nextTTVideo)?2200:4000)) errors.push("TikTok description exceeds its format limit.");
      if (nextVideo && nextImages.length) errors.push("Facebook videos cannot be combined with photos.");
      if (nextVideo && checkVideoUrl(nextVideo)) errors.push(checkVideoUrl(nextVideo)!);
      if (errors.length) return fail("Not saved. Fix these and try again.", { problems: errors, warnings: checks.warnings });
      const changed = await updatePost(
        env.DB,
        id,
        {
          status: "draft",
          message: nextMessage,
          tiktok_caption:nextTikTokCaption,
          images: nextImages,
          tiktok_images:nextTTImages,
          tiktok_video:nextTTVideo,
          video:nextVideo,
          link: link === undefined ? cur.link : link,
          scheduled_at: time.when?.toISOString() ?? null,
          label: label ?? cur.label,
          release: release ?? cur.release,
          note: cur.status === "rejected" ? cur.note : null,
        },
        ["draft", "rejected"],
      );
      if (!changed) return fail("The post changed status while saving. Fetch it again.");
      if (bluesky !== undefined || facebook_enabled !== undefined) {
        if (!(await saveBlueskyDraft(env.DB, id, bsNext, fbNext))) return fail("Could not save the Bluesky target.");
      }
      await audit(env.DB, actor(), cur.status === "rejected" ? "revised-rejected" : "edited", id);
      return ok({ saved: true, warnings: [...checks.warnings, ...(bsHouse?.warnings ?? [])], post: view(env, origin, (await getPost(env.DB, id))!) });
}

/** The exact read-only readiness response used by check_upload.
 * Stored status is only granted after native integrity pre-finalization.
 */
export async function checkUploadForEditor(env:Env,login:string,reference:string){
  if(!isCurrentEditor(env,login))
    return fail("Your authenticated account could not be identified. Reconnect GS Poster.");
  const result=await uploadStatusForOwner(env.DB,reference,login);
  return result ? ok({...result,ready:result.status==="stored"}) :
    fail("Upload not found or not owned by this account.");
}

export function buildServer(env: Env, origin: string): McpServer {
  const server = new McpServer({ name: "gs-poster", version: "0.1.0" });

  // OAuth-protected. The returned PUT URL is a short-lived bearer credential;
  // writing media never approves or publishes a post.
  // Optional GitHub bridge when the assistant can write original bytes to a
  // private GitHub blob but cannot PUT directly to the private GS Poster upload.
  // Import is OAuth-owner scoped and NEVER creates, approves or publishes a post.

  // ChatGPT's documented fileParams adapter injects authorized file objects
  // without embedding original binary bytes in the model tool arguments.
  // Other chat clients may not support it; the browser upload fallback remains.
  server.registerTool(
    "import_chatgpt_files",
    {
      title:"Import ChatGPT attachments privately into GS Poster",
      description:"Transfer up to 35 original user-selected ChatGPT image or MP4 attachments directly into private GS Poster storage, preserving order and returning upload:// references. This uses ChatGPT's fileParams attachment adapter, not text base64 or GitHub staging. Files may not be available on every ChatGPT client. If missing or unsupported, use request_uploads and private browser upload pages. Imports never create or publish a post.",
      inputSchema:z.object({
        files:z.array(z.object({
          download_url:z.string().min(1),
          file_id:z.string().min(1),
          mime_type:z.string().optional(),
          file_name:z.string().optional(),
        }).strict()).min(1).max(CHAT_BATCH_MAX_FILES),
      }),
      _meta:{"openai/fileParams":["files"]},
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
    },
    async ({files})=>{
      const login=currentOwner(env);
      if(!login)return fail("Authenticated editor identity unavailable. Reconnect GS Poster.");
      const result=await runNativeBatch(
        files,
        file=>importChatGPTFile(env,origin,login,file),
        stored=>audit(env.DB,actor(),"chatgpt-native-import",null,stored.reference),
      );
      return ok({
        ...result,
        next:result.stopped_reason
          ?"Retain confirmed upload references and inspect recoverable references using check_upload. Use request_uploads only for unconfirmed missing files; never re-upload a confirmed stored file."
          :"All references are stored for this editor. Use them in intended order in an unapproved draft. Nothing was published.",
      });
    },
  );

  server.registerTool(
    "import_github_blob",
    {
      title: "Copy a private GitHub binary blob into GS Poster storage",
      description: "Import an already-created private GitHub binary blob by SHA into GS Poster's private R2, returning a verified upload:// reference for later drafting. The source repository is fixed by server configuration and is never selected by the chat client. Use GitHub create_blob with encoding base64 only if you truly have the original attachment bytes; a picture description is not binary data. Optionally supply original-file SHA-256 to confirm exact bytes. This operation does not draft or publish. If binary access is unavailable, use request_upload and its private browser handoff.",
      inputSchema: z.object({
        filename: z.string().min(1).max(200).describe("Original filename ending in JPG, JPEG, PNG, GIF or MP4."),
        blob_sha: z.string().regex(/^[a-f0-9]{40}$/i).describe("GitHub SHA-1 blob object ID returned by create_blob in the configured private staging repository."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
          .describe("Optional SHA-256 of the actual original file bytes, for end-to-end integrity verification."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const login = currentOwner(env);
      if (!login) return fail("Account identity unavailable. Reconnect GS Poster.");
      try {
        const stored = await importStagedGitHubBlob(env,origin,login,input);
        await audit(env.DB,actor(),"github-blob-import",null,stored.reference);
        return ok({
          ...stored,
          next:"Call check_upload with reference to confirm owner-scoped readiness, then use the upload:// reference in draft_post. The GitHub staging blob is not deleted automatically. Nothing has been published.",
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "request_upload",
    {
      title: "Get a private one-time file upload link",
      description: "Create a one-time private JPG, PNG, GIF (up to 10 MB) or MP4 (up to 20 MB) upload link, valid for 10 minutes. Return upload_page_url to the editor: it opens a drag-and-drop uploader from Claude or ChatGPT, with no GitHub staging. If the assistant has direct access to file bytes in a code tool, it may PUT the original file to upload_url. Then check_upload before drafting. No publishing.",
      inputSchema: z.object({
        filename: z.string().min(1).max(200).describe("File name with extension. Only extension is retained."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ filename }) => {
      try {
        // Upload ownership must use the authenticated GitHub login, not the
        // human-readable MCP actor string (which includes the client name).
        const login=currentOwner(env);
        if(!login)return fail("Account identity unavailable. Reconnect GS Poster.");
        const grant = await createUpload(env, origin, { filename, actor: login });
        await audit(env.DB, actor(), "upload-link", null, grant.reference);
        return ok({
          ...grant,upload_page_url:grant.upload_url,
          next:"Open upload_page_url, select the file and upload privately. In a coding environment, PUT the file bytes to upload_url instead. Then call check_upload with reference and use the stored upload:// reference in draft_post or update_draft. Never share the bearer upload URL publicly."
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );



  server.registerTool(
    "check_upload",
    {
      title:"Check a private chat media upload",
      description:"After request_upload, check whether a JPG, PNG, GIF or MP4 upload actually arrived in private storage. Only the editor who requested the upload can inspect it. A stored upload:// reference can be passed to draft_post or update_draft. This does not publish.",
      inputSchema:z.object({
        reference:z.string().describe("The upload:// reference returned by request_upload."),
      }),
      annotations:{readOnlyHint:true,openWorldHint:false},
    },
    async ({reference})=>checkUploadForEditor(env,currentOwner(env),reference),
  );


  server.registerTool(
    "request_uploads",
    {
      title:"Prepare multiple private media uploads for a carousel or reel",
      description:"Request up to 35 private, one-time image or MP4 upload pages in a single call, retaining the order for TikTok carousels. Use the upload_page_url fields to transfer each actual file from a chat or mobile device, or send the bytes directly to upload_url if the assistant has file access. Call check_uploads afterwards. No GitHub staging and no publishing.",
      inputSchema:z.object({
        filenames:z.array(z.string().min(1).max(200)).min(1).max(CHAT_BATCH_MAX_FILES)
          .describe("Ordered list of JPG, JPEG, PNG, GIF, or MP4 filenames. One upload grant per file."),
      }),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
    },
    async ({filenames})=>{
      const login=currentOwner(env);
      if(!login)return fail("Account identity unavailable. Reconnect GS Poster.");
      try{
        const result=await createChatUploadBatch(env,origin,login,filenames);
        await audit(env.DB,actor(),"upload-batch",null,result.created+" private media upload links");
        return ok(result);
      }catch(error){return fail(error instanceof Error?error.message:String(error));}
    },
  );

  server.registerTool(
    "check_uploads",
    {
      title:"Verify a batch of chat media files in original carousel order",
      description:"Read-only check of up to 80 upload:// image or video references. Reports whether each file was actually stored and belongs to this authenticated editor. Use only ready files in a GS Poster draft. TikTok supports at most 35 carousel images, Bluesky at most four, and Facebook at most 80.",
      inputSchema:z.object({
        references:z.array(z.string().min(1)).min(1).max(CHAT_BATCH_CHECK_MAX)
          .describe("Private upload:// references in intended carousel order."),
      }),
      annotations:{readOnlyHint:true,openWorldHint:false},
    },
    async ({references})=>{
      const login=currentOwner(env);
      if(!login)return fail("Account identity unavailable. Reconnect GS Poster.");
      try{return ok(await checkChatUploadBatch(env.DB,login,references));}
      catch(error){return fail(error instanceof Error?error.message:String(error));}
    },
  );

  server.registerTool(
    "check_upload_usage",
    {
      title: "Check private R2 upload budget",
      description: "Read how many bytes GS Poster has stored or reserved, the remaining 3 GiB upload allowance, and the hourly link quota. This is NOT account-wide Cloudflare billing data.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      if(!currentOwner(env))return fail("Editor access is no longer authorized.");
      if (!env.UPLOADS) return fail("Private uploads are disabled (R2 storage is not bound).");
      try { return ok(await getUploadUsage(env.DB)); }
      catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    },
  );

  server.registerTool(
    "draft_post",
    {
      title: "Draft a GS Poster post",
      description:
        "Save a Facebook, Bluesky, TikTok or combined GS Grimoire DRAFT for approval. Nothing is published until Gus approves the target(s) on the review page with his PIN. Captions must follow the house rules (no em dashes, no prices, no Suno/Midjourney, current tier names); drafts that break them are refused with the reasons. Give publish_at in Copenhagen time like 2026-10-16T19:00, or full ISO 8601; omit it to post when Gus approves.",
      inputSchema: z.object({
        message: z.string().max(63206).describe("Facebook caption or shared descriptive caption. Text and hashtags are supported."),
        tiktok_caption:z.string().max(4000).optional().describe("Independent TikTok caption and hashtags. For videos use at most 2,200 characters, for photo carousels at most 4,000. Falls back to message if omitted."),
        facebook_enabled: z.boolean().default(true).describe("Select Facebook target. False is allowed when Bluesky or TikTok is selected."),
        tiktok_enabled: z.boolean().default(false).describe("Select TikTok as an independent draft target. Upload or direct publication on TikTok is a separate explicit PIN-approved web action. GS Poster does not automatically schedule TikTok releases."),
        bluesky: blueskySchema.optional().describe("Optional Bluesky target with its own caption, image alt descriptions and free Patreon link card."),
        images: imageList.optional(),
        tiktok_images:imageList.optional().describe("Independent TikTok carousel (up to 35). Omitted means legacy shared Facebook gallery."),
        tiktok_video:z.string().optional().describe("Independent TikTok MP4; cannot combine with TikTok images."),
        video: z.string().optional().describe("Facebook MP4 GitHub URL or private upload:// reference (20 MB maximum). Cannot be combined with Facebook images."),
        link: z.string().url().optional().describe("Optional link preview. Only used when the post has no images."),
        publish_at: z.string().optional().describe("When to publish. Copenhagen time (2026-10-16T19:00) or ISO 8601 with offset. 30 minutes to 30 days ahead."),
        label: z.string().max(120).optional().describe('Short name shown to Gus, e.g. "Day 1 creature reveal".'),
        release: z.string().max(120).optional().describe('Which product or release this belongs to, e.g. "Corvane Reckoning".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ message, tiktok_caption, images = [], tiktok_images,tiktok_video,video, link, publish_at, label, release, facebook_enabled, tiktok_enabled, bluesky }) => {
      const login=currentOwner(env);
      if(!login)return fail("Editor access is no longer authorized.");
      const privateErrors=await checkOwnedDraftMedia(env,login,[
        ...images,...(tiktok_images??[]),...(video?[video]:[]),
        ...(tiktok_video?[tiktok_video]:[]),
        ...(bluesky?.images.map(i=>i.url)??[]),
        ...(bluesky?.video?[bluesky.video.url]:[]),
      ]);
      if(privateErrors.length)return fail("Draft media access denied.",{problems:privateErrors});
      const checks = facebook_enabled?
        checkMessage(message,{hasImages:images.length>0||!!video}):
        tiktok_enabled?checkMessage(tiktok_caption??message,{
          hasImages:(tiktok_images??images).length>0||!!(tiktok_video??video)
        }):{errors:[],warnings:[]};
      const time = readWhen(env, publish_at);
      const imgErrors = await checkImages(env, images);
      const bsHouse = bluesky ? checkMessage(bluesky.caption, { hasImages: bluesky.images.length > 0 }) : null;
      const bsErrors = bluesky ? [...checkBluesky(bluesky), ...bsHouse!.errors, ...(await checkImages(env, bluesky.images.map((i) => i.url)))] : [];
      const errors = [...checks.errors, ...(time.error ? [time.error] : []), ...imgErrors, ...bsErrors];
      if (!facebook_enabled && !bluesky && !tiktok_enabled) errors.push("Select at least one of Facebook, Bluesky or TikTok.");
       const effectiveTTImages=tiktok_images??(tiktok_video?[]:images);
       if (tiktok_enabled && effectiveTTImages.length > 35) errors.push("TikTok carousels support at most 35 images.");
      if (tiktok_images && !tiktok_enabled) errors.push("TikTok gallery requires TikTok target.");
      if (tiktok_video && !tiktok_enabled) errors.push("TikTok video requires TikTok target.");
      if (tiktok_video && effectiveTTImages.length) errors.push("TikTok cannot combine video with a gallery.");
      if (tiktok_video && checkVideoUrl(tiktok_video))errors.push(checkVideoUrl(tiktok_video)!);
       if (tiktok_images) errors.push(...(await checkImages(env,tiktok_images)));
      if (video && !facebook_enabled && !tiktok_enabled) errors.push("A video requires Facebook or TikTok.");
      if(tiktok_caption!==undefined && !tiktok_enabled) errors.push("TikTok caption requires the TikTok target.");
      if(tiktok_enabled && (tiktok_caption ?? message).length>((tiktok_video||(tiktok_images===undefined&&!!video))?2200:4000)) errors.push("TikTok description exceeds its format limit.");
      if (video && images.length) errors.push("Facebook videos cannot be combined with photos.");
      if (video && link) errors.push("Facebook videos cannot also have a link preview.");
      if (video && checkVideoUrl(video)) errors.push(checkVideoUrl(video)!);
      if (errors.length) return fail("Draft not saved. Fix these and try again.", { problems: errors, warnings: checks.warnings });
      const p = await createPost(env.DB, {
        message,
        tiktok_caption:tiktok_caption ?? null,
        images,
        tiktok_images:tiktok_images??(tiktok_video?[]:null),tiktok_video:tiktok_video??null,
        video:video ?? null,
        link: link ?? null,
        scheduled_at: time.when?.toISOString() ?? null,
        label: label ?? null,
        release: release ?? null,
        created_by: actor(),
        facebook_enabled,
        tiktok_enabled,
        bluesky: bluesky ?? null,
      });
      await audit(env.DB, actor(), "drafted", p.id, label);
      return ok({ saved: true, note: "Waiting for Gus to approve. Not published.", warnings: [...checks.warnings, ...(bsHouse?.warnings ?? [])], post: view(env, origin, p) });
    },
  );

  server.registerTool(
    "update_draft",
    {
      title: "Revise a draft",
      description:
        "Change a draft or a rejected post. A rejected post goes back to draft for Gus to review again; read gus_note first to see what he asked for. Only the fields you pass are changed. Pass publish_at as an empty string to post on approval instead of at a set time.",
      inputSchema: updateDraftSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async input => handleUpdateDraft(env,origin,currentOwner(env),input),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete a draft",
      description: "Delete a draft or rejected post that should not go out. Cannot touch anything already approved.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      if(!currentOwner(env))return fail("Editor access is no longer authorized.");
      const okDel = await deletePost(env.DB, id, ["draft", "rejected"]);
      if (!okDel) return fail("Not deleted: no draft or rejected post with that id.");
      await audit(env.DB, actor(), "deleted", id);
      return ok({ deleted: id });
    },
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description:
        "List posts in GS Poster, newest first: drafts waiting for Gus, rejected ones (with his note), scheduled, published and failed. Use it to check what is already queued before drafting a release.",
      inputSchema: z.object({
        status: z.enum(STATUSES).optional(),
        release: z.string().optional().describe("Only posts for this release."),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, release, limit }) => {
      if(!currentOwner(env))return fail("Editor access is no longer authorized.");
      await refreshScheduled(env).catch(() => undefined);
      let posts = await listPosts(env.DB, { status: status as PostStatus | undefined, limit: limit ?? 30 });
      if (release) posts = posts.filter((p) => (p.release ?? "").toLowerCase() === release.toLowerCase());
      return ok({ count: posts.length, review_site: origin, posts: posts.map((p) => view(env, origin, p)) });
    },
  );

  server.registerTool(
    "get_post",
    {
      title: "Get one post",
      description: "Full details of one post, including Gus's note if he rejected it and the Facebook error if it failed.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      if(!currentOwner(env))return fail("Editor access is no longer authorized.");
      const p = await getPost(env.DB, id);
      return p ? ok(view(env, origin, p)) : fail(`No post with id ${id}.`);
    },
  );

  server.registerTool(
    "list_page_posts",
    {
      title: "Read the Facebook Page",
      description:
        "What is actually on the GS Grimoire Facebook Page: recent published posts with reactions, comments and shares, or the posts on Facebook's schedule (including ones Gus scheduled by hand). Read-only.",
      inputSchema: z.object({
        kind: z.enum(["published", "scheduled"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ kind, limit }) => {
      if(!currentOwner(env))return fail("Editor access is no longer authorized.");
      try {
        const k = kind ?? "published";
        const posts = await listPagePosts(env, k, limit ?? 10);
        return ok({
          kind: k,
          posts: posts.map((p) => ({
            ...p,
            scheduled_local: p.scheduled_publish_time ? formatLocal(new Date(p.scheduled_publish_time * 1000), env.TIMEZONE) : undefined,
          })),
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "check_setup",
    {
      title: "Check the connection",
      description: "Report which settings are missing and whether the Facebook Page token works. Use it first, or when something fails.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if(!currentOwner(env))return fail("Editor access is no longer authorized.");
      const missing = missingSecrets(env);
      let facebook: unknown = "skipped: FB_PAGE_ID or FB_PAGE_TOKEN missing";
      if (env.FB_PAGE_ID && env.FB_PAGE_TOKEN) {
        try {
          facebook = { ok: true, page: await checkPage(env) };
        } catch (e) {
          facebook = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      let github_staging: unknown = {ok:false,error:"GitHub staging requires GITHUB_STAGING_REPO, GITHUB_READ_TOKEN and private uploads."};
      if (env.GITHUB_STAGING_REPO && env.GITHUB_READ_TOKEN && env.UPLOADS) {
        try {
          github_staging = await verifyPrivateStagingRepo(env);
        } catch (e) {
          // Explicitly allow only predefined diagnostic messages. Do not
          // return a token, request URL, stack, or upstream response content.
          const message = e instanceof Error ? e.message : "";
          let safe = "GitHub connection failed before a usable response. Check the Worker network and GitHub API availability.";
          if (message.startsWith("Private GitHub staging is not configured"))
            safe = "Invalid GITHUB_STAGING_REPO value. Set only the exact owner/repository name, without a URL, quotes or variable-name prefix.";
          else if (message.startsWith("Private GitHub staging requires GITHUB_READ_TOKEN"))
            safe = "GITHUB_READ_TOKEN is not available in this Worker.";
          else if (message.startsWith("GS Poster private upload storage is unavailable"))
            safe = "Private upload storage is unavailable in this Worker.";
          else if (/^GitHub staging (token was rejected|token lacks access|repository was not found|repository check returned HTTP|repository lookup redirected|HTTPS request failed|repository metadata was not valid JSON|repository metadata did not confirm)/.test(message))
            safe = message;
          github_staging = {ok:false,error:safe};
        }
      }
      return ok({
        review_site: origin,
        github_staging,
        missing_secrets: missing,
        optional: { FB_APP_SECRET: !!env.FB_APP_SECRET, GITHUB_READ_TOKEN: !!env.GITHUB_READ_TOKEN, GITHUB_STAGING_REPO: !!env.GITHUB_STAGING_REPO, UPLOADS: !!env.UPLOADS, IMAGES: !!env.IMAGES, BSKY_HANDLE: !!env.BSKY_HANDLE, BSKY_APP_PASSWORD: !!env.BSKY_APP_PASSWORD },
        bluesky: { configured: !!env.BSKY_HANDLE && !!env.BSKY_APP_PASSWORD, images_ready: !!env.IMAGES },
        upload_usage: env.UPLOADS ? await getUploadUsage(env.DB) : null,
        graph_version: env.GRAPH_VERSION,
        timezone: env.TIMEZONE,
        facebook,
      });
    },
  );

  return server;
}
