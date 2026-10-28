import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,attachDraftImage,getPost} from "../src/db.ts";
import {ensureTikTokSchema,sealTikTokTokens} from "../src/tiktok.ts";
import {startTikTokContentTransfer,validateTikTokPostOptions,type TikTokPostOptions} from "../src/tiktok-posting.ts";
import {createTikTokMediaGrant,serveTikTokMedia,saveTikTokVerificationFile,TIKTOK_MEDIA_PREFIX} from "../src/tiktok-media.ts";
import {getTikTokInboxTransfer} from "../src/tiktok-inbox.ts";
import {tiktokOptionsPage} from "../src/tiktok-options.ts";
import type {Env} from "../src/env.ts";
import type {Session} from "../src/session.ts";

let worker:Miniflare,env:Env;
const session={login:"GSGrimoire",raw:"test-session"} as Session;
const ref="upload://"+"b".repeat(32)+".png";
before(async()=>{
 worker=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
  script:"export default {fetch(){return new Response('test')}}",
  compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
 env={DB:await worker.getD1Database("DB") as unknown as D1Database,
  COOKIE_SECRET:"test-secret",TIKTOK_CLIENT_KEY:"sandbox-key",TIKTOK_CLIENT_SECRET:"sandbox-secret",
  TIKTOK_TOKEN_ENCRYPTION_KEY:"this-is-a-secure-test-only-encryption-key-123"} as Env;
 await ensureTikTokSchema(env.DB);
 const now=Math.floor(Date.now()/1000);
 const token={access_token:"fake-access",refresh_token:"fake-refresh",open_id:"creator",
  scope:"user.info.basic,video.upload,video.publish",expires_in:3600,
  refresh_expires_in:200000,token_type:"Bearer"};
 await env.DB.prepare(
  "INSERT INTO tiktok_accounts(account_key,open_id,token_cipher,scopes,connected_by,access_expires_at,refresh_expires_at,updated_at) "+
  "VALUES('primary',?,?,?,?,?,?,?)"
 ).bind(token.open_id,await sealTikTokTokens(env,token),token.scope,
  session.login,now+3600,now+200000,new Date().toISOString()).run();
});
after(async()=>worker?.dispose());
async function draft(){
 const p=await createPost(env.DB,{message:"Fantasy carousel",label:"GS Carousel",
  images:[],video:null,created_by:"test",scheduled_at:null,facebook_enabled:false,
  tiktok_enabled:true,bluesky:null});
 const rev=await attachDraftImage(env.DB,p.id,ref,"",false,false,p.updated_at,true);
 assert.ok(rev);
 return (await getPost(env.DB,p.id))!;
}
const options=(mode:"MEDIA_UPLOAD"|"DIRECT_POST"):TikTokPostOptions=>({
 mode,mediaType:"PHOTO",caption:"Rules in pictures",title:"House rules",
 privacy:mode==="DIRECT_POST"?"SELF_ONLY":"",disableComment:false,
 disableDuet:false,disableStitch:false,autoMusic:false,brandOrganic:false,
 brandContent:false,aiGenerated:false,
});
test("TikTok-only images remain unapproved and are not Facebook posts",async()=>{
 const p=await draft();
 assert.equal(p.facebook_enabled,false);
 assert.equal(p.tiktok_enabled,true);
 assert.deepEqual(p.images,[ref]);
 assert.equal(p.approved_at,null);
});
test("public pull URLs are random, short-lived and never redirect",async()=>{
 const p=await draft();
 const url=await createTikTokMediaGrant(env,p.id,ref,"image",session.login);
 assert.ok(url.startsWith(TIKTOK_MEDIA_PREFIX));
 assert.match(url,/\.webp$/);
 assert.equal((await serveTikTokMedia(new Request(TIKTOK_MEDIA_PREFIX+"not-found.webp"),env)).status,404);
 const row=await env.DB.prepare("SELECT token_hash FROM tiktok_media_grants WHERE post_id=?").bind(p.id).first<{token_hash:string}>();
 assert.ok(row&&!url.includes(row.token_hash));
 await env.DB.prepare("UPDATE tiktok_media_grants SET expires_at=0 WHERE post_id=?").bind(p.id).run();
 assert.equal((await serveTikTokMedia(new Request(url),env)).status,404);
});
test("TikTok ownership verification files are plain text",async()=>{
 await saveTikTokVerificationFile(env.DB,"tiktok_verify_987654.txt","verification-string");
 const res=await serveTikTokMedia(new Request(TIKTOK_MEDIA_PREFIX+"tiktok_verify_987654.txt"),env);
 assert.equal(res.status,200);
 assert.equal(res.headers.get("Content-Type"),"text/plain; charset=utf-8");
 assert.equal(await res.text(),"verification-string");
 await assert.rejects(saveTikTokVerificationFile(env.DB,"../../evil.html","bad"));
});
test("PHOTO MEDIA_UPLOAD sends PULL_FROM_URL photos in order, once",async()=>{
 const p=await draft();
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async(input,init)=>{
  calls++;
  assert.equal(String(input),"https://open.tiktokapis.com/v2/post/publish/content/init/");
  assert.equal(init?.redirect,"manual");
  const body=JSON.parse(String(init?.body));
  assert.equal(body.media_type,"PHOTO");
  assert.equal(body.post_mode,"MEDIA_UPLOAD");
  assert.equal(body.source_info.source,"PULL_FROM_URL");
  assert.equal(body.source_info.photo_cover_index,0);
  assert.ok(body.source_info.photo_images[0].startsWith(TIKTOK_MEDIA_PREFIX));
  return Response.json({data:{publish_id:"p_inbox_url~test"},error:{code:"ok"}});
 };
 try {
  const result=await startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD"));
  assert.equal(result.status,"processing");
  assert.equal(result.media_type,"PHOTO");
  await assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/already exists/);
  assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});
test("Direct PHOTO requires fresh TikTok creator options and SELF_ONLY",async()=>{
 const p=await draft();
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async(input,init)=>{
  calls++;
  if(String(input).endsWith("/creator_info/query/"))
   return Response.json({data:{creator_username:"test",creator_nickname:"Creator",
    privacy_level_options:["SELF_ONLY","PUBLIC_TO_EVERYONE"],comment_disabled:false,
    duet_disabled:false,stitch_disabled:false},error:{code:"ok"}});
  const body=JSON.parse(String(init?.body));
  assert.equal(body.post_mode,"DIRECT_POST");
  assert.equal(body.post_info.privacy_level,"SELF_ONLY");
  return Response.json({data:{publish_id:"p_pub_url~test"},error:{code:"ok"}});
 };
 try{
  const page=await tiktokOptionsPage(env,session,p.id);
  assert.match(await page.text(),/Publish privately now/);
  const result=await startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("DIRECT_POST"));
  assert.equal(result.status,"processing");
  assert.equal(result.post_mode,"DIRECT_POST");
  assert.ok(calls>=3);
 }finally{globalThis.fetch=old;}
});
test("Unreviewed direct publishing never accepts PUBLIC_TO_EVERYONE",()=>{
 assert.throws(()=>validateTikTokPostOptions({...options("DIRECT_POST"),privacy:"PUBLIC_TO_EVERYONE"}),/SELF_ONLY/);
});
