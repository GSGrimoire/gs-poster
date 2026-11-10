/**
 * Explicit, signed-in conversion of an already attached GitHub MP4 into an
 * owner-bound private upload. None of these paths approve or publish media.
 */
import type { Env } from "./env.ts";
import { getPost, replacePreparedVideoReference } from "./db.ts";
import { parseGitHubUrl } from "./media.ts";
import { checkVideoUrl, openGitHubVideoSource } from "./video.ts";
import { createUpload, handleUploadPut, isStoredOwnerVideo, verifyStoredUploadParts } from "./upload.ts";

export type VideoPrepareTarget = "tiktok" | "bluesky" | "instagram";
export class VideoPrepareError extends Error {
  status: number;
  constructor(message:string,status=400) { super(message); this.status=status; }
}

export async function prepareLinkedVideo(
  env:Env,id:string,target:VideoPrepareTarget,expected:string,actor:string,origin:string,
):Promise<{reference:string;updated_at:string}> {
  const p=await getPost(env.DB,id);
  if(!p)throw new VideoPrepareError("Post not found.",404);
  if(!["draft","rejected"].includes(p.status)||p.approved_at)
    throw new VideoPrepareError("Only unapproved drafts can prepare video.",409);
  if(p.updated_at!==expected)
    throw new VideoPrepareError("The draft changed. Reload before preparing video.",409);
  let source:string|null|undefined;
  if(target==="tiktok") {
    if(!p.tiktok_enabled||p.tiktok_images===null||p.tiktok_images.length)
      throw new VideoPrepareError("Select TikTok with a separate video-only gallery first.",409);
    source=p.tiktok_video;
  }else if(target==="bluesky") {
    if(!p.bluesky||p.bluesky.images.length)
      throw new VideoPrepareError("Select Bluesky with a video-only gallery first.",409);
    source=p.bluesky.video?.url;
  }else if(target==="instagram"){
    if(!p.instagram||p.instagram.items.length)
      throw new VideoPrepareError("Select Instagram with a Reel video, not photos, first.",409);
    source=p.instagram.video;
  }else throw new VideoPrepareError("Unsupported video target.");
  if(!source||!parseGitHubUrl(source)||checkVideoUrl(source))
    throw new VideoPrepareError("Only existing GitHub-linked MP4 videos can be prepared.");
  if(!env.UPLOADS)throw new VideoPrepareError("Private media storage is not configured.",503);

  // Never hold an entire 40-50 MB GitHub video in Worker memory. The
  // authenticated source is streamed into bounded 5 MiB R2 multipart parts.
  const upstream=await openGitHubVideoSource(env,source);
  const declared=upstream.headers.get("content-length");
  const grant=await createUpload(env,origin,{filename:"prepared.mp4",actor});
  const request=new Request(grant.upload_url,{
    method:"PUT",headers:declared?{"Content-Length":declared}:{},
    body:upstream.body,
    duplex:"half",
  } as RequestInit & {duplex:"half"});
  const response=await handleUploadPut(request,env,{
    internalUnknownLength:true,
    verifyBeforeFinalize:verifyStoredUploadParts.bind(null,env),
  });
  if(!response.ok)
    throw new VideoPrepareError("Private video storage was not confirmed. Reload and inspect before retrying.",502);
  if(!(await isStoredOwnerVideo(env.DB,grant.reference,actor)))
    throw new VideoPrepareError("The video is not confirmed as an owned private upload.",502);

  let updated:string|null;
  try {updated=await replacePreparedVideoReference(env.DB,id,target,source,grant.reference,expected);}
  catch {
    throw new VideoPrepareError("The final video save is uncertain. Reload and inspect before retrying.",502);
  }
  if(!updated)throw new VideoPrepareError("The draft changed during video preparation. Reload before retrying.",409);
  return {reference:grant.reference,updated_at:updated};
}
