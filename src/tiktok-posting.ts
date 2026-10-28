/** Explicit, PIN-gated TikTok photo carousels and private Direct Post testing.
 * Uses TikTok PULL_FROM_URL from short-lived, unguessable public grants.
 * Does not schedule TikTok posts or bypass creator consent.
 */
import type {Env} from "./env.ts";
import {getPost,audit} from "./db.ts";
import {tiktokAccessToken,getTikTokCreatorOptions} from "./tiktok.ts";
import {createTikTokMediaGrant,ensureTikTokMediaSchema} from "./tiktok-media.ts";
import {ensureTikTokInboxSchema,getTikTokInboxTransfer,type TikTokInboxTransfer} from "./tiktok-inbox.ts";
import {parseUploadRef} from "./upload.ts";

export type TikTokPostMode="MEDIA_UPLOAD"|"DIRECT_POST";
export type TikTokMediaType="PHOTO"|"VIDEO";
export interface TikTokPostOptions {
  mode:TikTokPostMode;mediaType:TikTokMediaType;
  caption:string;title:string;privacy:string;
  disableComment:boolean;disableDuet:boolean;disableStitch:boolean;
  autoMusic:boolean;brandOrganic:boolean;brandContent:boolean;aiGenerated:boolean;
}
const API="https://open.tiktokapis.com";
export function validateTikTokPostOptions(options:TikTokPostOptions) {
  if(!["MEDIA_UPLOAD","DIRECT_POST"].includes(options.mode))throw Error("Invalid TikTok posting mode.");
  if(!["PHOTO","VIDEO"].includes(options.mediaType))throw Error("Invalid TikTok media type.");
  if(options.title.length>90)throw Error("TikTok photo title exceeds 90 characters.");
  if(options.caption.length>(options.mediaType==="PHOTO"?4000:2200))
    throw Error("TikTok caption is too long.");
  if(options.brandOrganic&&options.brandContent)
    throw Error("Select either your own brand or paid partnership, not both.");
  if(options.mode==="DIRECT_POST"&&options.privacy!=="SELF_ONLY")
    throw Error("For this unaudited application, direct post tests must use SELF_ONLY privacy.");
  if(options.mode==="DIRECT_POST"&&options.brandContent&&options.privacy==="SELF_ONLY")
    throw Error("Private-only direct tests cannot include third-party branded content.");
}
async function contentInit(env:Env,options:TikTokPostOptions,urls:string[]) {
  const token=await tiktokAccessToken(env,options.mode==="DIRECT_POST"?"video.publish":"video.upload");
  const info:Record<string,unknown>={
    title:options.title,description:options.caption,
  };
  if(options.mode==="DIRECT_POST") {
    info.privacy_level=options.privacy;
    info.disable_comment=options.disableComment;
    info.brand_organic_toggle=options.brandOrganic;
    info.brand_content_toggle=options.brandContent;
    if(options.mediaType==="PHOTO") info.auto_add_music=options.autoMusic;
    else {
      info.title=options.caption.slice(0,2200);
      delete info.description;
      info.disable_duet=options.disableDuet;
      info.disable_stitch=options.disableStitch;
    }
  }
  const payload:Record<string,unknown>={
    media_type:options.mediaType,post_mode:options.mode,
    post_info:info,
    source_info:options.mediaType==="PHOTO"?
      {source:"PULL_FROM_URL",photo_cover_index:0,photo_images:urls}:
      {source:"PULL_FROM_URL",video_url:urls[0]},
    is_aigc:options.aiGenerated,
  };
  const endpoint=options.mediaType==="PHOTO"?
    "/v2/post/publish/content/init/":"/v2/post/publish/video/init/";
  const result=await fetch(API+endpoint,{
    method:"POST",headers:{"Authorization":"Bearer "+token,
      "Content-Type":"application/json; charset=UTF-8"},
    body:JSON.stringify(payload),redirect:"manual",
  });
  const data=await result.json().catch(()=>({})) as {
    data?:{publish_id?:string};error?:{code?:string;message?:string};
  };
  if(!result.ok||data.error?.code!=="ok"||!data.data?.publish_id ||
    data.data.publish_id.length>64) {
    // Permit the platform's known error code, but never expose tokens or URLs.
    const code=String(data.error?.code||"unknown");
    throw new Error("TikTok rejected the transfer ("+
      (/^[a-z0-9_]{1,100}$/.test(code)?code:"unknown")+").");
  }
  return data.data.publish_id;
}

export async function startTikTokContentTransfer(
  env:Env,postId:string,expectedVersion:string,actor:string,options:TikTokPostOptions,
):Promise<TikTokInboxTransfer> {
  validateTikTokPostOptions(options);
  const p=await getPost(env.DB,postId);
  if(!p || !p.tiktok_enabled || p.updated_at!==expectedVersion)
    throw Error("TikTok target changed. Reload before posting.");
  if(!["draft","scheduled","published"].includes(p.status))
    throw Error("This post cannot be sent to TikTok in its current state.");
  const refs=options.mediaType==="PHOTO"?p.images:
    p.video?[p.video]:[];
  if(!refs.length)throw Error(options.mediaType==="PHOTO"?
    "Attach images to the TikTok draft first.":"Attach an MP4 to the TikTok draft first.");
  if(options.mediaType==="PHOTO"&&refs.length>35)
    throw Error("TikTok supports at most 35 photos per carousel.");
  for(const ref of refs){
    const parsed=parseUploadRef(ref);
    if(!parsed|| (options.mediaType==="VIDEO")!==(parsed.ext==="mp4"))
      throw Error("TikTok needs private uploaded images or video. Reattach the files first.");
  }
  // Validate creator permissions and current available privacy levels before
  // claiming a direct post. Direct test still uses private SELF_ONLY only.
  if(options.mode==="DIRECT_POST") {
    const creator=await getTikTokCreatorOptions(env);
    if(!creator.privacy_level_options.includes(options.privacy))
      throw Error("Privacy option is not currently available for this TikTok account.");
    if(creator.comment_disabled&&!options.disableComment)
      throw Error("TikTok has disabled comments for this account.");
    if(options.mediaType==="VIDEO"&&
      (creator.duet_disabled&&!options.disableDuet||
       creator.stitch_disabled&&!options.disableStitch))
      throw Error("TikTok has disabled Duets or Stitches for this account.");
  } else {
    await tiktokAccessToken(env,"video.upload");
  }
  await ensureTikTokInboxSchema(env.DB);
  await ensureTikTokMediaSchema(env.DB);
  // Atomic and irreversible claim BEFORE creating public share links or
  // calling TikTok prevents concurrent duplicate publishes.
  const when=new Date().toISOString();
  const inserted=await env.DB.prepare(
    "INSERT OR IGNORE INTO tiktok_inbox_transfers "+
    "(post_id,status,publish_id,media_ref,created_at,updated_at,sent_by,error,remote_status,post_mode,media_type) "+
    "VALUES (?,'transferring',NULL,?,?,?,?,NULL,NULL,?,?)"
  ).bind(postId,JSON.stringify(refs),when,when,actor,options.mode,options.mediaType).run();
  if(inserted.meta.changes!==1)
    throw Error("A TikTok transfer already exists for this post; check its status before retrying.");
  try {
    const urls:string[]=[];
    for(const ref of refs)urls.push(await createTikTokMediaGrant(env,postId,ref,
      options.mediaType==="PHOTO"?"image":"video",actor));
    const publishId=await contentInit(env,options,urls);
    await env.DB.prepare(
      "UPDATE tiktok_inbox_transfers SET publish_id=?,status='processing',updated_at=? "+
      "WHERE post_id=? AND status='transferring' AND publish_id IS NULL"
    ).bind(publishId,new Date().toISOString(),postId).run();
    await audit(env.DB,actor,
      options.mode==="DIRECT_POST"?"tiktok-direct-post-started":"tiktok-carousel-upload-started",
      postId,options.mode+" "+options.mediaType+"; processing by TikTok").catch(()=>undefined);
  }catch{
    await env.DB.prepare(
      "UPDATE tiktok_inbox_transfers SET status='needs_review',error=?,updated_at=? "+
      "WHERE post_id=? AND status='transferring'"
    ).bind("Transfer outcome uncertain or rejected. Check TikTok before attempting another transfer.",
      new Date().toISOString(),postId).run().catch(()=>undefined);
    throw Error("TikTok transfer was not confirmed. Check TikTok and its permissions. No automatic retry was made.");
  }
  return (await getTikTokInboxTransfer(env.DB,postId))!;
}
