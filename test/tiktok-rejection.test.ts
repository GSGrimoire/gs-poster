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
import {getTikTokInboxTransfer,clearUnconfirmedTikTokTransfer,startTikTokInboxTransfer} from "../src/tiktok-inbox.ts";
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
   /url_ownership_unverified.*Nothing was created on TikTok.*verification file/s);
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
 assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"rejected");
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
