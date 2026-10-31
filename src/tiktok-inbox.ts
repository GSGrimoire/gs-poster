/** Manually initiated TikTok inbox transfers. They never directly publish videos.
 * Existing media is read from the same private store as Facebook/Bluesky.
 */
import type {Env} from "./env.ts";
import {getPost,audit,tiktokMedia} from "./db.ts";
import {fetchVideo,INITIAL_VIDEO_MAX_BYTES} from "./video.ts";
import {tiktokAccessToken,tiktokConnection} from "./tiktok.ts";

export type TikTokInboxStatus = "transferring"|"transfer_complete"|"inbox_ready"|"processing"|"published_by_creator"|"failed"|"needs_review"|"rejected";

/** TikTok answered with an explicit error code and no publish_id: nothing was created there. */
export class TikTokRejected extends Error {
  readonly code:string;
  constructor(code:string) {
    super(tiktokRejectionAdvice(code));
    this.code=code;
  }
}
/** Only TikTok's lower-case error codes are kept; never tokens, URLs or free text. */
export function safeTikTokCode(value:unknown):string {
  const code=String(value??"");
  return /^[a-z0-9_]{1,100}$/.test(code)?code:"unknown";
}
export function tiktokRejectionAdvice(code:string):string {
  const advice:Record<string,string>={
    url_ownership_unverified:"TikTok has not verified GS Poster's media address, so it may not fetch the images. Open TikTok settings in GS Poster, host the verification file from TikTok's developer portal (URL properties), and finish the verification there.",
    unaudited_client_can_only_post_to_private_accounts:"The TikTok app is not audited yet, so Direct Post only works while the TikTok account is set to private. Use 'Send to TikTok inbox' instead, or make the account private for the test.",
    scope_not_authorized:"TikTok has not granted the permission this needs. Disconnect and reconnect TikTok with the right permissions.",
    access_token_invalid:"The TikTok connection has expired or been revoked. Reconnect TikTok.",
    privacy_level_option_mismatch:"That privacy option is not available for this TikTok account. Pick another.",
    spam_risk_too_many_posts:"TikTok's daily posting limit was reached. Try again tomorrow.",
    spam_risk_user_banned_from_posting:"TikTok currently blocks posting from this account.",
    reached_active_user_cap:"The TikTok app's daily user limit was reached. Try again later.",
    rate_limit_exceeded:"TikTok is rate limiting requests. Wait a few minutes and try again.",
    invalid_params:"TikTok rejected the request details (caption, title or photo count).",
    picture_size_check_failed:"TikTok rejected an image size. Use images of at most 1080 pixels and 20 MB.",
    file_format_check_failed:"TikTok rejected an image or video format.",
  };
  return "TikTok rejected the transfer ("+code+"). Nothing was created on TikTok. "+
    (advice[code]??"Check the TikTok developer app and account, then try again.");
}
/** Claim SQL: a new row, or a fresh attempt over a definitively rejected one. */
export const TIKTOK_CLAIM_CONFLICT=
  " ON CONFLICT(post_id) DO UPDATE SET status='transferring',publish_id=NULL,media_ref=excluded.media_ref,"+
  "created_at=excluded.created_at,updated_at=excluded.updated_at,sent_by=excluded.sent_by,error=NULL,"+
  "remote_status=NULL,post_mode=excluded.post_mode,media_type=excluded.media_type "+
  "WHERE tiktok_inbox_transfers.status='rejected' AND tiktok_inbox_transfers.publish_id IS NULL";
/** Revoke public pull links for a post once its transfer is known to have been refused. */
export async function revokeTikTokGrants(db:D1Database,postId:string):Promise<void> {
  await db.prepare("DELETE FROM tiktok_media_grants WHERE post_id=?").bind(postId).run().catch(()=>undefined);
}
/** Record a definitive TikTok refusal so the editor may fix the cause and try again. */
export async function markTikTokRejected(db:D1Database,postId:string,code:string,actor:string):Promise<void> {
  await db.prepare(
    "UPDATE tiktok_inbox_transfers SET status='rejected',error=?,remote_status=?,updated_at=? "+
    "WHERE post_id=? AND status='transferring' AND publish_id IS NULL"
  ).bind(tiktokRejectionAdvice(code),code,new Date().toISOString(),postId).run();
  await revokeTikTokGrants(db,postId);
  await audit(db,actor,"tiktok-transfer-rejected",postId,code).catch(()=>undefined);
}
/**
 * PIN-gated: an editor checked TikTok and confirms that an uncertain transfer
 * without any publish_id did not arrive. Only then may a new attempt be made.
 * A transfer that has a publish_id is never cleared here.
 */
export async function clearUnconfirmedTikTokTransfer(db:D1Database,postId:string,actor:string):Promise<boolean> {
  await ensureTikTokInboxSchema(db);
  const res=await db.prepare(
    "UPDATE tiktok_inbox_transfers SET status='rejected',error=?,updated_at=? "+
    "WHERE post_id=? AND status='needs_review' AND publish_id IS NULL"
  ).bind("Cleared after the editor checked TikTok and found nothing. You can send it again.",
    new Date().toISOString(),postId).run();
  if((res.meta.changes??0)!==1)return false;
  await revokeTikTokGrants(db,postId);
  await audit(db,actor,"tiktok-transfer-cleared",postId,"editor confirmed absent on TikTok").catch(()=>undefined);
  return true;
}
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
async function postJson<T>(env:Env,path:string,payload:object,scope:"video.upload"|"video.publish"="video.upload"):Promise<T> {
  const access=await tiktokAccessToken(env,scope);
  const res=await fetch(API+path,{
    method:"POST",
    headers:{"Authorization":"Bearer "+access,"Content-Type":"application/json; charset=UTF-8"},
    body:JSON.stringify(payload),redirect:"manual",
  });
  const parsed=await res.json().catch(()=>({})) as {data?:T;error?:{code?:string}};
  if(parsed.error?.code && parsed.error.code!=="ok")throw new TikTokRejected(safeTikTokCode(parsed.error.code));
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
  if(!post.tiktok_enabled)throw new Error("TikTok is not selected for this draft.");
  const media=tiktokMedia(post).video;
  if(!media)throw new Error("Attach an MP4 video to the post first.");
  if(!/^upload:\/\/[a-f0-9]{32}\.mp4$/.test(media))
    throw new Error("TikTok inbox transfer requires a private uploaded MP4. Please reattach it in GS Poster.");
  const bytes=await fetchVideo(env,media);
  if(!bytes.length||bytes.length>INITIAL_VIDEO_MAX_BYTES)throw new Error("Video must be under 20 MB.");
  await ensureTikTokInboxSchema(env.DB);
  // Claim before making the external call. Never automatically retry a potentially sent video.
  const now=new Date().toISOString();
  const claim=await env.DB.prepare(
    "INSERT INTO tiktok_inbox_transfers "+
    "(post_id,status,publish_id,media_ref,created_at,updated_at,sent_by,error,remote_status,post_mode,media_type) "+
    "VALUES (?,'transferring',NULL,?,?,?,?,NULL,NULL,'MEDIA_UPLOAD','VIDEO')"+TIKTOK_CLAIM_CONFLICT
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
    if(stage==="initialization"&&error instanceof TikTokRejected){
      await markTikTokRejected(env.DB,postId,error.code,actor);
      throw error;
    }
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
    env,"/v2/post/publish/status/fetch/",{publish_id:row.publish_id},row.post_mode==="DIRECT_POST"?"video.publish":"video.upload");
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
