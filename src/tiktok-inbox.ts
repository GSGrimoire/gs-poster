/** Manually initiated TikTok inbox transfers. They never directly publish videos.
 * Existing media is read from the same private store as Facebook/Bluesky.
 */
import type {Env} from "./env.ts";
import {getPost,audit} from "./db.ts";
import {fetchVideo,INITIAL_VIDEO_MAX_BYTES} from "./video.ts";
import {tiktokAccessToken,tiktokConnection} from "./tiktok.ts";

export type TikTokInboxStatus = "transferring"|"transfer_complete"|"inbox_ready"|"processing"|"published_by_creator"|"failed"|"needs_review";
export interface TikTokInboxTransfer {
  post_id:string;status:TikTokInboxStatus;publish_id:string|null;
  media_ref:string;created_at:string;updated_at:string;sent_by:string;error:string|null;
  remote_status:string|null;
  post_mode?: "MEDIA_UPLOAD"|"DIRECT_POST"; media_type?: "VIDEO"|"PHOTO";
}
const API="https://open.tiktokapis.com";
export function allowedTikTokUploadUrl(value:string):boolean {
  try {
    const u=new URL(value);
    // TikTok returns signed upload URLs. Never forward a signed URL to an unrelated host.
    return u.protocol==="https:"&&u.port===""&&u.username===""&&u.password==="" &&
      (u.hostname==="open-upload.tiktokapis.com" ||
       /^upload(?:\.[a-z0-9-]+)?\.tiktokapis\.com$/.test(u.hostname)) &&
      u.pathname.startsWith("/video/");
  }catch{return false;}
}
export async function ensureTikTokInboxSchema(db:D1Database):Promise<void> {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS tiktok_inbox_transfers "+
    "(post_id TEXT PRIMARY KEY,status TEXT NOT NULL,publish_id TEXT,media_ref TEXT NOT NULL,"+
    "created_at TEXT NOT NULL,updated_at TEXT NOT NULL,sent_by TEXT NOT NULL,error TEXT,remote_status TEXT)"
  ).run();
  const columns=await db.prepare("PRAGMA table_info(tiktok_inbox_transfers)").all<{name:string}>();
  for(const [col,definition] of [["post_mode","TEXT NOT NULL DEFAULT 'MEDIA_UPLOAD'"],["media_type","TEXT NOT NULL DEFAULT 'VIDEO'"]]) {
    if(!columns.results.some(x=>x.name===col)) {
      try{await db.prepare("ALTER TABLE tiktok_inbox_transfers ADD COLUMN "+col+" "+definition).run();}
      catch(error){if(!/duplicate column name/i.test(String(error)))throw error;}
    }
  }
}
export async function getTikTokInboxTransfer(db:D1Database,id:string):Promise<TikTokInboxTransfer|null> {
  await ensureTikTokInboxSchema(db);
  return await db.prepare("SELECT * FROM tiktok_inbox_transfers WHERE post_id=?")
    .bind(id).first<TikTokInboxTransfer>()??null;
}
async function postJson<T>(env:Env,path:string,payload:object):Promise<T> {
  const access=await tiktokAccessToken(env,"video.upload");
  const res=await fetch(API+path,{
    method:"POST",
    headers:{"Authorization":"Bearer "+access,"Content-Type":"application/json; charset=UTF-8"},
    body:JSON.stringify(payload),redirect:"manual",
  });
  const parsed=await res.json().catch(()=>({})) as {data?:T;error?:{code?:string}};
  if(!res.ok || parsed.error?.code!=="ok" || !parsed.data)
    throw new Error("TikTok rejected the request. Check Content Posting API approval, permission limits and account status.");
  return parsed.data;
}
export async function startTikTokInboxTransfer(
  env:Env,postId:string,expectedVersion:string,actor:string,
):Promise<TikTokInboxTransfer> {
  if(!await tiktokConnection(env.DB))throw new Error("Connect TikTok first.");
  const post=await getPost(env.DB,postId);
  if(!post||post.updated_at!==expectedVersion)throw new Error("Post changed. Reload before uploading.");
  if(post.status==="publishing" || post.status==="cancelled" || post.status==="failed" ||
     post.status==="rejected")
    throw new Error("This post cannot be transferred in its current state.");
  const media=post.video||post.bluesky?.video?.url;
  if(!media)throw new Error("Attach an MP4 video to the post first.");
  if(!/^upload:\/\/[a-f0-9]{32}\.mp4$/.test(media))
    throw new Error("TikTok inbox transfer requires a private uploaded MP4. Please reattach it in GS Poster.");
  const bytes=await fetchVideo(env,media);
  if(!bytes.length||bytes.length>INITIAL_VIDEO_MAX_BYTES)throw new Error("Video must be under 20 MB.");
  await ensureTikTokInboxSchema(env.DB);
  // Claim before making the external call. Never automatically retry a potentially sent video.
  const now=new Date().toISOString();
  const claim=await env.DB.prepare(
    "INSERT OR IGNORE INTO tiktok_inbox_transfers "+
    "(post_id,status,publish_id,media_ref,created_at,updated_at,sent_by,error,remote_status) "+
    "VALUES (?,'transferring',NULL,?,?,?,?,NULL,NULL)"
  ).bind(postId,media,now,now,actor).run();
  if(claim.meta.changes!==1)
    throw new Error("A TikTok upload already exists for this post. Check its status before attempting another upload.");
  let stage="initialization";
  try {
    const data=await postJson<{publish_id?:string;upload_url?:string}>(
      env,"/v2/post/publish/inbox/video/init/",{
        source_info:{source:"FILE_UPLOAD",video_size:bytes.length,chunk_size:bytes.length,total_chunk_count:1},
      });
    if(!data.publish_id||data.publish_id.length>64||!data.upload_url||!allowedTikTokUploadUrl(data.upload_url))
      throw new Error("TikTok returned an invalid upload destination or publish identifier.");
    // Record publish_id BEFORE uploading bytes for subsequent status reconciliation.
    const saved=await env.DB.prepare(
      "UPDATE tiktok_inbox_transfers SET publish_id=?,updated_at=? WHERE post_id=? AND status='transferring' AND publish_id IS NULL"
    ).bind(data.publish_id,new Date().toISOString(),postId).run();
    if(saved.meta.changes!==1)throw new Error("Upload state changed before transfer.");
    stage="transfer";
    const result=await fetch(data.upload_url,{
      method:"PUT",redirect:"manual",
      headers:{"Content-Type":"video/mp4","Content-Length":String(bytes.length),
        "Content-Range":"bytes 0-"+(bytes.length-1)+"/"+bytes.length},
      body:bytes,
    });
    if(result.status!==201)throw new Error("TikTok did not confirm receipt of the complete video.");
    await env.DB.prepare(
      "UPDATE tiktok_inbox_transfers SET status='transfer_complete',updated_at=? "+
      "WHERE post_id=? AND publish_id=? AND status='transferring'"
    ).bind(new Date().toISOString(),postId,data.publish_id).run();
    await audit(env.DB,actor,"tiktok-inbox-video-transferred",postId,
      "TikTok video transfer completed; creator must publish in app").catch(()=>undefined);
  }catch(error){
    const msg=stage==="transfer"
      ? "Upload may have reached TikTok. Check status before any new attempt."
      : "TikTok could not initialize the video upload. Check app permissions and account.";
    await env.DB.prepare(
      "UPDATE tiktok_inbox_transfers SET status='needs_review',error=?,updated_at=? WHERE post_id=? AND status='transferring'"
    ).bind(msg,new Date().toISOString(),postId).run().catch(()=>undefined);
    throw new Error(msg);
  }
  return (await getTikTokInboxTransfer(env.DB,postId))!;
}
export async function refreshTikTokInboxTransfer(env:Env,id:string,actor:string):Promise<TikTokInboxTransfer> {
  const row=await getTikTokInboxTransfer(env.DB,id);
  if(!row||!row.publish_id)throw new Error("No TikTok publish ID is recorded for this post.");
  const data=await postJson<{status?:string;fail_reason?:string}>(
    env,"/v2/post/publish/status/fetch/",{publish_id:row.publish_id});
  const remote=String(data.status||"");
  const status:TikTokInboxStatus=remote==="SEND_TO_USER_INBOX"?"inbox_ready":
    remote==="PUBLISH_COMPLETE"?"published_by_creator":
    remote==="FAILED"?"failed":"processing";
  // No retry or publish side effect. Record only status.
  await env.DB.prepare(
    "UPDATE tiktok_inbox_transfers SET status=?,remote_status=?,error=?,updated_at=? WHERE post_id=? AND publish_id=?"
  ).bind(status,remote,remote==="FAILED"?"TikTok reported the video could not be processed.":null,
    new Date().toISOString(),id,row.publish_id).run();
  await audit(env.DB,actor,"tiktok-inbox-status-checked",id,remote).catch(()=>undefined);
  return (await getTikTokInboxTransfer(env.DB,id))!;
}
