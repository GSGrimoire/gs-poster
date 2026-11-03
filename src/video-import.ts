/**
 * Explicit, signed-in conversion of an already attached GitHub MP4 into an
 * owner-bound private upload. None of these paths approve or publish media.
 */
import type { Env } from "./env.ts";
import { getPost, replacePreparedVideoReference } from "./db.ts";
import { parseGitHubUrl } from "./media.ts";
import { checkVideoUrl, fetchVideo, INITIAL_VIDEO_MAX_BYTES } from "./video.ts";
import { createUpload, handleUploadPut, isStoredOwnerVideo, readUpload } from "./upload.ts";

export type VideoPrepareTarget = "tiktok" | "bluesky" | "instagram";
export class VideoPrepareError extends Error {
  status: number;
  constructor(message:string,status=400) { super(message); this.status=status; }
}

async function fingerprint(bytes:ArrayBuffer):Promise<string> {
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(digest,v=>v.toString(16).padStart(2,"0")).join("");
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

  // fetchVideo has a bounded streaming read, an MP4 signature check and a
  // strict GitHub-only source. No arbitrary client URL enters the fetch.
  const bytes=await fetchVideo(env,source);
  if(!bytes.byteLength||bytes.byteLength>INITIAL_VIDEO_MAX_BYTES)
    throw new VideoPrepareError("The MP4 is empty or exceeds 20 MB.");
  const original=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  const expectedHash=await fingerprint(original);
  const grant=await createUpload(env,origin,{filename:"prepared.mp4",actor});
  const response=await handleUploadPut(new Request(grant.upload_url,{
    method:"PUT",headers:{"Content-Length":String(bytes.byteLength)},body:original,
  }),env,{verifyBeforeFinalize:async ref=>{
    const stored=await readUpload(env,ref);
    if(stored.byteLength!==original.byteLength || await fingerprint(stored)!==expectedHash)
      throw new Error("Private video copy failed the integrity check.");
  }});
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
