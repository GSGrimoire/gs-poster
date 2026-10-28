/** Short-lived public TikTok pull URLs for media explicitly authorized by a human editor.
 * Neither the private R2 upload key nor a session cookie is exposed to TikTok.
 * URLs are unguessable, individually hashed in D1, expire, and never redirect.
 */
import type {Env} from "./env.ts";
import {fetchImage} from "./media.ts";
import {fetchVideo} from "./video.ts";
import {parseUploadRef} from "./upload.ts";
import {randomToken,sha256} from "./session.ts";

export const TIKTOK_MEDIA_PREFIX="https://gs-poster.goofyspook.workers.dev/tiktok/media/";
export const MEDIA_LEASE_SECONDS=3*3600;

export async function ensureTikTokMediaSchema(db:D1Database):Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS tiktok_media_grants "+
      "(token_hash TEXT PRIMARY KEY,post_id TEXT NOT NULL,media_ref TEXT NOT NULL,"+
      "kind TEXT NOT NULL,expires_at INTEGER NOT NULL,created_by TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS tiktok_media_expiry ON tiktok_media_grants(expires_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tiktok_media_verification "+
      "(filename TEXT PRIMARY KEY,contents TEXT NOT NULL,updated_at TEXT NOT NULL)"),
  ]);
}
/** Issue a public URL only after an explicit PIN-gated transfer is claimed.
 * Restrict references to owner-controlled private uploads.
 */
export async function createTikTokMediaGrant(
  env:Env,postId:string,reference:string,kind:"image"|"video",actor:string,
):Promise<string> {
  const parsed=parseUploadRef(reference);
  if(!parsed || (kind==="video")!==(parsed.ext==="mp4"))
    throw new Error("TikTok needs a private uploaded image or MP4; please reattach media.");
  await ensureTikTokMediaSchema(env.DB);
  const token=randomToken();
  const hash=await sha256(token);
  const ext=kind==="image"?"webp":"mp4";
  const expires=Math.floor(Date.now()/1000)+MEDIA_LEASE_SECONDS;
  await env.DB.prepare(
    "INSERT INTO tiktok_media_grants(token_hash,post_id,media_ref,kind,expires_at,created_by) VALUES(?,?,?,?,?,?)"
  ).bind(hash,postId,reference,kind,expires,actor).run();
  return TIKTOK_MEDIA_PREFIX+token+"."+ext;
}
/** Public verification file supplied by the owner from the TikTok URL properties UI.
 * Strict filename and text/plain MIME prevent arbitrary HTML hosting.
 */
export function validVerificationFile(filename:string,contents:string):boolean {
  return /^[a-zA-Z0-9_-]{8,100}\.txt$/.test(filename) &&
    contents.length>0&&contents.length<=8192 && !/[\u0000-\u0008]/.test(contents);
}
export async function saveTikTokVerificationFile(db:D1Database,filename:string,contents:string) {
  if(!validVerificationFile(filename,contents))throw new Error(
    "Verification must be a .txt filename of 8-100 letters, digits, underscores or hyphens and at most 8 KB.");
  await ensureTikTokMediaSchema(db);
  await db.prepare(
    "INSERT INTO tiktok_media_verification(filename,contents,updated_at) VALUES(?,?,?) "+
    "ON CONFLICT(filename) DO UPDATE SET contents=excluded.contents,updated_at=excluded.updated_at"
  ).bind(filename,contents,new Date().toISOString()).run();
}
export async function serveTikTokMedia(req:Request,env:Env):Promise<Response> {
  if(req.method!=="GET"&&req.method!=="HEAD")
    return new Response("Method not allowed",{status:405,headers:{Allow:"GET, HEAD"}});
  const path=new URL(req.url).pathname;
  const pathPart=path.slice("/tiktok/media/".length);
  await ensureTikTokMediaSchema(env.DB);
  const extra={"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
    "X-Robots-Tag":"noindex, nofollow","Cache-Control":"no-store"};
  const verify=/^([a-zA-Z0-9_-]{8,100}\.txt)$/.exec(pathPart);
  if(verify) {
    const row=await env.DB.prepare(
      "SELECT contents FROM tiktok_media_verification WHERE filename=?"
    ).bind(verify[1]).first<{contents:string}>();
    if(!row)return new Response("Not found",{status:404,headers:extra});
    return new Response(req.method==="HEAD"?null:row.contents,
      {headers:{...extra,"Content-Type":"text/plain; charset=utf-8"}});
  }
  const match=/^([A-Za-z0-9_-]{32,90})\.(webp|mp4)$/.exec(pathPart);
  if(!match)return new Response("Not found",{status:404,headers:extra});
  const hash=await sha256(match[1]);
  const row=await env.DB.prepare(
    "SELECT media_ref,kind FROM tiktok_media_grants WHERE token_hash=? AND expires_at>?"
  ).bind(hash,Math.floor(Date.now()/1000)).first<{media_ref:string;kind:string}>();
  if(!row || (match[2]==="mp4")!==(row.kind==="video"))
    return new Response("Not found",{status:404,headers:extra});
  if(req.method==="HEAD")return new Response(null,{
    headers:{...extra,"Content-Type":row.kind==="video"?"video/mp4":"image/webp"}
  });
  try {
    if(row.kind==="video"){
      const video=await fetchVideo(env,row.media_ref);
      return new Response(video,{headers:{...extra,"Content-Type":"video/mp4",
        "Content-Length":String(video.length)}});
    }
    if(!env.IMAGES)throw new Error("Image conversion unavailable");
    const img=await fetchImage(env,row.media_ref);
    // TikTok accepts JPEG and WebP, not PNG or GIF. Convert from private
    // source bytes instead of redirecting TikTok to the private object.
    const conversion=await env.IMAGES.input(new Blob([img.bytes]).stream())
      .transform({width:1080,fit:"scale-down"})
      .output({format:"image/webp"});
    const result=conversion.response();
    if(!result.ok)throw new Error("Could not convert photo");
    const headers=new Headers(result.headers);
    Object.entries(extra).forEach(([k,v])=>headers.set(k,v));
    headers.set("Content-Type","image/webp");
    return new Response(result.body,{status:200,headers});
  }catch{
    return new Response("Media unavailable",{status:502,headers:extra});
  }
}
