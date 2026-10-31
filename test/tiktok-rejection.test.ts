// Issue: TikTok carousels failed with no visible reason and locked the post.
// A definitive TikTok refusal must keep its error code, revoke public links and
// allow a fresh PIN-approved attempt. Uncertain attempts stay blocked until an
// editor checks TikTok and clears them with the PIN.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,attachDraftImage,getPost} from "../src/db.ts";
import {ensureTikTokSchema,sealTikTokTokens} from "../src/tiktok.ts";
import {startTikTokContentTransfer,type TikTokPostOptions} from "../src/tiktok-posting.ts";
import {getTikTokInboxTransfer,clearUnconfirmedTikTokTransfer,startTikTokInboxTransfer,markTikTokRejected,classifyTikTokInit} from "../src/tiktok-inbox.ts";
import {tiktokOptionsPage} from "../src/tiktok-options.ts";
import {tiktokSettings} from "../src/tiktok-web.ts";
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

async function withFetch<T>(handler:(url:string,init?:RequestInit)=>Response|Promise<Response>,fn:()=>Promise<T>) {
 const old=globalThis.fetch;const calls:string[]=[];
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input);calls.push(url);
  return handler(url,init);
 }) as typeof fetch;
 try{return {result:await fn(),calls};}finally{globalThis.fetch=old;}
}
const rejectWith=(code:string)=>()=>Response.json({error:{code,message:"x",log_id:"l"}},{status:403});
const grants=async(id:string)=>(await env.DB.prepare("SELECT COUNT(*) AS n FROM tiktok_media_grants WHERE post_id=?").bind(id).first<{n:number}>())!.n;

test("url_ownership_unverified is shown with its code and advice, and links are revoked",async()=>{
 const p=await draft();
 const {calls}=await withFetch(rejectWith("url_ownership_unverified"),async()=>{
  await assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),
   /url_ownership_unverified.*no publish ID.*verification file/s);
 });
 assert.equal(calls.length,1);
 const row=(await getTikTokInboxTransfer(env.DB,p.id))!;
 assert.equal(row.status,"rejected");
 assert.equal(row.publish_id,null);
 assert.equal(row.remote_status,"url_ownership_unverified");
 assert.match(row.error??"",/verification file/);
 assert.equal(await grants(p.id),0);
 const audit=await env.DB.prepare("SELECT detail FROM audit WHERE post_id=? AND action='tiktok-transfer-rejected'").bind(p.id).first<{detail:string}>();
 assert.equal(audit?.detail,"url_ownership_unverified");
});

test("after a definitive rejection, a new attempt is allowed once and succeeds",async()=>{
 const p=await draft();
 await withFetch(rejectWith("url_ownership_unverified"),()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD"))));
 assert.equal((await tiktokOptionsPage(env,session,p.id)).status,200);
 let inits=0;
 const {result}=await withFetch(()=>{inits++;return Response.json({data:{publish_id:"p_inbox_url~retry"},error:{code:"ok"}});},
  ()=>startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")));
 assert.equal(inits,1);
 assert.equal(result.status,"processing");
 assert.equal(result.publish_id,"p_inbox_url~retry");
 assert.equal(result.error,null);
 assert.equal(result.remote_status,null);
 // A processing transfer can never be overwritten by another attempt.
 await withFetch(()=>{throw new Error("must not call TikTok");},()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/already exists/));
 assert.equal((await tiktokOptionsPage(env,session,p.id)).status,409);
});

test("Direct Post on an unaudited app explains the private-account rule",async()=>{
 const p=await draft();
 await withFetch(url=>url.endsWith("/creator_info/query/")
  ? Response.json({data:{creator_username:"t",creator_nickname:"T",privacy_level_options:["SELF_ONLY"],
     comment_disabled:false,duet_disabled:false,stitch_disabled:false},error:{code:"ok"}})
  : rejectWith("unaudited_client_can_only_post_to_private_accounts")(),
  ()=>assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("DIRECT_POST")),
   /unaudited_client_can_only_post_to_private_accounts.*Send to TikTok inbox/s));
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"rejected");
});

test("an unknown or unsafe error code is reduced to 'unknown'",async()=>{
 const p=await draft();
 await withFetch(()=>Response.json({error:{code:"<script>alert(1)</script>"}},{status:400}),()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/\(unknown\)/));
 const row=(await getTikTokInboxTransfer(env.DB,p.id))!;
 assert.equal(row.remote_status,"unknown");
 assert.doesNotMatch(row.error??"",/script/);
});

test("a network failure stays uncertain and blocks a new attempt",async()=>{
 const p=await draft();
 await withFetch(()=>{throw new TypeError("network down");},()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/not confirmed/));
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"needs_review");
 await withFetch(()=>{throw new Error("must not call TikTok");},()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/already exists/));
 assert.equal((await tiktokOptionsPage(env,session,p.id)).status,409);
});

test("an ok answer without a publish_id stays uncertain",async()=>{
 const p=await draft();
 await withFetch(()=>Response.json({data:{},error:{code:"ok"}}),()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/not confirmed/));
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"needs_review");
});

test("clearing an uncertain attempt needs no publish_id, then allows a resend",async()=>{
 const p=await draft();
 await withFetch(()=>{throw new TypeError("network down");},()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD"))));
 assert.ok(await grants(p.id)>0);
 assert.equal(await clearUnconfirmedTikTokTransfer(env.DB,p.id,session.login),true);
 assert.equal(await grants(p.id),0);
 const cleared=(await getTikTokInboxTransfer(env.DB,p.id))!;
 assert.equal(cleared.status,"cleared");
 assert.match(cleared.error??"",/Cleared by GSGrimoire.*never confirmed/);
 // One-shot: a second clear finds nothing to clear.
 assert.equal(await clearUnconfirmedTikTokTransfer(env.DB,p.id,session.login),false);
 const {result}=await withFetch(()=>Response.json({data:{publish_id:"p_inbox_url~after_clear"},error:{code:"ok"}}),
  ()=>startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")));
 assert.equal(result.status,"processing");
});

test("a transfer with a publish_id can never be cleared",async()=>{
 const p=await draft();
 await withFetch(()=>Response.json({data:{publish_id:"p_inbox_url~kept"},error:{code:"ok"}}),
  ()=>startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")));
 await env.DB.prepare("UPDATE tiktok_inbox_transfers SET status='needs_review' WHERE post_id=?").bind(p.id).run();
 assert.equal(await clearUnconfirmedTikTokTransfer(env.DB,p.id,session.login),false);
 const row=(await getTikTokInboxTransfer(env.DB,p.id))!;
 assert.equal(row.status,"needs_review");
 assert.equal(row.publish_id,"p_inbox_url~kept");
});

test("settings page says when no verification file is hosted",async()=>{
 await env.DB.prepare("DELETE FROM tiktok_media_verification").run().catch(()=>undefined);
 const text=await (await tiktokSettings(env,session)).text();
 assert.match(text,/no verification file hosted/);
 assert.match(text,/url_ownership_unverified/);
});

// ---- Review 31 Oct, finding 1: a publish_id always means "uncertain" ----
for(const [label,mode] of [["PHOTO MEDIA_UPLOAD","MEDIA_UPLOAD"],["PHOTO DIRECT_POST","DIRECT_POST"]] as const){
 test(`${label}: an error code WITH a publish_id is uncertain, keeps the id and blocks a resend`,async()=>{
  const p=await draft();
  await withFetch(url=>url.endsWith("/creator_info/query/")
   ? Response.json({data:{creator_username:"t",creator_nickname:"T",privacy_level_options:["SELF_ONLY"],
      comment_disabled:false,duet_disabled:false,stitch_disabled:false},error:{code:"ok"}})
   : Response.json({data:{publish_id:"p_pub_url~maybe"},error:{code:"internal_error"}},{status:400}),
   ()=>assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options(mode)),/not confirmed/));
  const row=(await getTikTokInboxTransfer(env.DB,p.id))!;
  assert.equal(row.status,"needs_review");
  assert.equal(row.publish_id,"p_pub_url~maybe");
  assert.ok(await grants(p.id)>0,"grants are kept while TikTok may still fetch");
  assert.equal(await clearUnconfirmedTikTokTransfer(env.DB,p.id,session.login),false);
  let inits=0;
  await withFetch(url=>{
   if(url.endsWith("/creator_info/query/"))return Response.json({data:{creator_username:"t",creator_nickname:"T",
    privacy_level_options:["SELF_ONLY"],comment_disabled:false,duet_disabled:false,stitch_disabled:false},error:{code:"ok"}});
   inits++;throw new Error("must not call TikTok init");
  },()=>assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options(mode)),/already exists/));
  assert.equal(inits,0);
 });
}
test("a 5xx error with no publish_id is uncertain, not a refusal",async()=>{
 const p=await draft();
 await withFetch(()=>Response.json({error:{code:"internal_error"}},{status:500}),()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/not confirmed/));
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"needs_review");
});
test("classification table",()=>{
 assert.equal(classifyTikTokInit(403,{error:{code:"url_ownership_unverified"}}).kind,"rejected");
 assert.equal(classifyTikTokInit(403,{data:{publish_id:"x"},error:{code:"url_ownership_unverified"}}).kind,"uncertain");
 assert.equal(classifyTikTokInit(200,{data:{publish_id:"x"},error:{code:"spam_risk_too_many_posts"}}).kind,"uncertain");
 assert.equal(classifyTikTokInit(200,{error:{code:"spam_risk_too_many_posts"}}).kind,"uncertain");
 assert.equal(classifyTikTokInit(502,{}).kind,"uncertain");
 assert.equal(classifyTikTokInit(200,{data:{publish_id:"bad id with spaces"},error:{code:"ok"}}).kind,"uncertain");
 assert.equal(classifyTikTokInit(200,{data:{publish_id:"v_inbox~1"},error:{code:"ok"}}).kind,"ok");
});

// ---- Video inbox path ----
const videoRef="upload://"+"c".repeat(32)+".mp4";
function stubVideo(){
 const bytes=new Uint8Array(4096);bytes.set([0,0,0,24,102,116,121,112,105,115,111,109],0);
 env.UPLOADS={get:async()=>({arrayBuffer:async()=>bytes.buffer})} as unknown as R2Bucket;
}
async function videoDraft(){
 const p=await createPost(env.DB,{message:"Video",images:[],video:videoRef,scheduled_at:null,
  created_by:"test",facebook_enabled:false,tiktok_enabled:true,bluesky:null});
 return (await getPost(env.DB,p.id))!;
}
test("VIDEO: a definitive refusal is recorded and a resend succeeds",async()=>{
 stubVideo();const p=await videoDraft();
 await withFetch(rejectWith("scope_not_authorized"),()=>
  assert.rejects(startTikTokInboxTransfer(env,p.id,p.updated_at,session.login),/scope_not_authorized.*reconnect/is));
 const row=(await getTikTokInboxTransfer(env.DB,p.id))!;
 assert.equal(row.status,"rejected");
 assert.equal(row.media_type,"VIDEO");
 let puts=0;
 const {result}=await withFetch((url)=>{
  if(url.endsWith("/inbox/video/init/"))return Response.json({data:{publish_id:"v_inbox~retry",
   upload_url:"https://open-upload.tiktokapis.com/video/?upload_id=1"},error:{code:"ok"}});
  puts++;return new Response(null,{status:201});
 },()=>startTikTokInboxTransfer(env,p.id,p.updated_at,session.login));
 assert.equal(result.status,"transfer_complete");
 assert.equal(result.publish_id,"v_inbox~retry");
 assert.equal(puts,1);
});
test("VIDEO: error code with a publish_id is uncertain and keeps the id",async()=>{
 stubVideo();const p=await videoDraft();
 await withFetch(()=>Response.json({data:{publish_id:"v_inbox~maybe"},error:{code:"internal_error"}},{status:400}),()=>
  assert.rejects(startTikTokInboxTransfer(env,p.id,p.updated_at,session.login),/clear answer/));
 const row=(await getTikTokInboxTransfer(env.DB,p.id))!;
 assert.equal(row.status,"needs_review");
 assert.equal(row.publish_id,"v_inbox~maybe");
 assert.equal(await clearUnconfirmedTikTokTransfer(env.DB,p.id,session.login),false);
});

// ---- Finding 2: attempt fencing and failure handling ----
test("a stale rejection for an earlier attempt cannot touch a newer attempt or its grants",async()=>{
 const p=await draft();
 await withFetch(rejectWith("url_ownership_unverified"),()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD"))));
 const first=(await getTikTokInboxTransfer(env.DB,p.id))!;
 // A second attempt claims the row and has live grants while in flight.
 await new Promise(r=>setTimeout(r,5));
 await withFetch(()=>Response.json({data:{publish_id:"p_inbox~second"},error:{code:"ok"}}),
  ()=>startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")));
 await env.DB.prepare("UPDATE tiktok_inbox_transfers SET status='transferring',publish_id=NULL WHERE post_id=?").bind(p.id).run();
 const before=await grants(p.id);
 assert.ok(before>0);
 assert.equal(await markTikTokRejected(env.DB,p.id,first.created_at,"url_ownership_unverified","late"),false);
 assert.equal(await grants(p.id),before,"newer attempt's grants survive");
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"transferring");
});
test("if recording the refusal fails, the attempt stays blocked instead of retryable",async()=>{
 const p=await draft();
 const real=env.DB;let broken=false;
 const failing=new Proxy(real,{get(t,k){
  if(k==="batch"&&broken)return async()=>{throw new Error("D1 unavailable");};
  const v=Reflect.get(t,k);return typeof v==="function"?v.bind(t):v;
 }}) as D1Database;
 env.DB=failing;
 try{
  // D1 starts failing only once TikTok has answered, i.e. while recording the refusal.
  await withFetch(()=>{broken=true;return rejectWith("url_ownership_unverified")();},()=>
   assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/could not record it safely/));
 }finally{env.DB=real;}
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"needs_review");
 await withFetch(()=>{throw new Error("must not call TikTok");},()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD")),/already exists/));
});
test("a failing clear reports failure and leaves the attempt and its grants alone",async()=>{
 const p=await draft();
 await withFetch(()=>{throw new TypeError("down");},()=>
  assert.rejects(startTikTokContentTransfer(env,p.id,p.updated_at,session.login,options("MEDIA_UPLOAD"))));
 const n=await grants(p.id);
 const failing=new Proxy(env.DB,{get(t,k){
  if(k==="batch")return async()=>{throw new Error("D1 unavailable");};
  const v=Reflect.get(t,k);return typeof v==="function"?v.bind(t):v;
 }}) as D1Database;
 await assert.rejects(clearUnconfirmedTikTokTransfer(failing,p.id,session.login));
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"needs_review");
 assert.equal(await grants(p.id),n);
});

