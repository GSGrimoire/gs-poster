// Issue #61 part B: TikTok in the same PIN approval as Facebook and Bluesky.
// Real bundled handleWeb in workerd. Every outbound request is recorded; a
// fake TikTok API answers TikTok hosts and everything else is refused, so a
// Facebook Graph call would show up as a recorded, refused request.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {markTikTokCreatorPublished} from "../src/history.ts";
import {ensureFacebookQueue} from "../src/facebook-queue.ts";
import {ensureTikTokSchema,sealTikTokTokens} from "../src/tiktok.ts";
import {ensureTikTokInboxSchema} from "../src/tiktok-inbox.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="one-pin-test-cookie-secret";
const PIN="975310"; // test-only value
const TT_KEY="this-is-a-secure-test-only-encryption-key-456";
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const MSG="Goblin carousel. Free in the Archive: patreon.com/GSGrimoire";
let mf:Miniflare,db:D1Database,r2:R2Bucket;
const outbound:{method:string;url:string}[]=[];
let tiktokMode:"ok"|"reject"|"network"="ok";
let seq=0;
let remoteTikTokStatus = "PUBLISH_COMPLETE";
let holdTikTokRenewal: (() => Promise<void>) | undefined;

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:out.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["UPLOADS"],
    outboundService:async(req:Request)=>{
      outbound.push({method:req.method,url:req.url});
      const u=new URL(req.url);
      if(u.hostname==="open.tiktokapis.com"&&u.pathname.endsWith("/init/")){
        if(tiktokMode==="network")return new Response("upstream timeout",{status:504});
        if(tiktokMode==="reject")return Response.json({error:{code:"spam_risk_too_many_posts",message:"x"}},{status:403});
        const publish_id="v_pub_test_"+(++seq);
        return Response.json({data:u.pathname.includes("/inbox/video/")
          ?{publish_id,upload_url:"https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=test"}:{publish_id},error:{code:"ok"}});
      }
      if(u.hostname==="open.tiktokapis.com"&&u.pathname.endsWith("/status/fetch/"))
        return Response.json({data:{status:remoteTikTokStatus,fail_reason:"picture_size_check_failed"},error:{code:"ok"}});
      if(u.hostname==="open.tiktokapis.com"&&u.pathname.endsWith("/oauth/token/")){
        await holdTikTokRenewal?.();
        return Response.json({access_token:"fake-renewed-access",refresh_token:"fake-refresh",open_id:"creator",
          scope:"user.info.basic,video.upload",expires_in:3600,refresh_expires_in:200000,token_type:"Bearer"});
      }
      if(u.hostname==="open-upload.tiktokapis.com"&&req.method==="PUT")return new Response(null,{status:201});
      return new Response("blocked in test",{status:599});
    },
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,TIMEZONE:"Europe/Copenhagen",
      TIKTOK_CLIENT_KEY:"sandbox-key",TIKTOK_CLIENT_SECRET:"sandbox-secret",TIKTOK_TOKEN_ENCRYPTION_KEY:TT_KEY}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  r2=await mf.getR2Bucket("UPLOADS") as unknown as R2Bucket;
  await ensureSchema(db);await ensureFacebookQueue(db);await ensureTikTokSchema(db);await ensureTikTokInboxSchema(db);
});
after(async()=>{await mf?.dispose();});

async function connectTikTok(scope="user.info.basic,video.upload"){
  const now=Math.floor(Date.now()/1000);
  const token={access_token:"fake-access",refresh_token:"fake-refresh",open_id:"creator",scope,
    expires_in:3600,refresh_expires_in:200000,token_type:"Bearer"};
  await db.prepare("DELETE FROM tiktok_accounts").run();
  await db.prepare("INSERT INTO tiktok_accounts(account_key,open_id,token_cipher,scopes,connected_by,access_expires_at,refresh_expires_at,updated_at) VALUES('primary',?,?,?,?,?,?,?)")
    .bind("creator",await sealTikTokTokens({TIKTOK_CLIENT_KEY:"sandbox-key",TIKTOK_CLIENT_SECRET:"sandbox-secret",TIKTOK_TOKEN_ENCRYPTION_KEY:TT_KEY} as Env,token),scope,"GSGrimoire",now+3600,now+200000,new Date().toISOString()).run();
}
const hex=(n:number,c:string)=>c.repeat(32).slice(0,32-String(n).length)+n;
const photo=(n:number)=>"upload://"+hex(n,"a")+".png";
async function ttDraft(o:{facebook?:boolean;scheduledH?:number;photos?:number;video?:boolean}={}){
  let video:string|null=null;
  if(o.video){
    video="upload://"+hex(++seq,"c")+".mp4";
    const bytes=new Uint8Array(64);bytes.set([0,0,0,32,0x66,0x74,0x79,0x70],0);
    await r2.put("uploads/"+video.slice(9),bytes);
  }
  const images=o.video?[]:Array.from({length:o.photos??3},(_,i)=>photo(++seq*10+i));
  return createPost(db,{message:MSG,label:"Internal GS Poster title",tiktok_title:o.video?null:"Public goblin gallery",release:"NPC",images,video,created_by:"test",
    scheduled_at:o.scheduledH?new Date(Date.now()+o.scheduledH*3600e3).toISOString():null,
    facebook_enabled:o.facebook??false,tiktok_enabled:true,bluesky:null} as any);
}
async function send(path:string,fields:Record<string,string>,o:{login?:string|null;origin?:string;csrf?:string}={}){
  const headers:Record<string,string>={Origin:o.origin??ORIGIN,"Sec-Fetch-Site":o.origin&&o.origin!==ORIGIN?"cross-site":"same-origin",
    "Content-Type":"application/x-www-form-urlencoded"};
  let csrf=o.csrf;
  if(o.login!==null){
    const raw=await makeSession(signer,o.login??"GSGrimoire");
    headers.Cookie=SESSION_COOKIE+"="+raw;
    csrf??=await csrfToken(signer,{login:o.login??"GSGrimoire",raw} as Session);
  }
  return mf.dispatchFetch(ORIGIN+path,{method:"POST",headers,body:new URLSearchParams({csrf:csrf??"",...fields}).toString(),redirect:"manual"});
}
async function page(id:string){
  const raw=await makeSession(signer,"GSGrimoire");
  return (await mf.dispatchFetch(ORIGIN+"/post/"+id,{headers:{Cookie:SESSION_COOKIE+"="+raw}})).text();
}
const approve=(p:{id:string;updated_at:string},extra:Record<string,string>={})=>
  send("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_tiktok:"1",confirm_tiktok:"1",pin:PIN,...extra});
const transfer=(id:string)=>db.prepare("SELECT status,publish_id,media_type FROM tiktok_inbox_transfers WHERE post_id=?").bind(id)
  .first<{status:string;publish_id:string|null;media_type:string}>();
const tiktokCalls=()=>outbound.filter(r=>r.url.includes("tiktokapis.com"));
const facebookCalls=()=>outbound.filter(r=>r.url.includes("facebook.com"));
const reset=async()=>{outbound.length=0;tiktokMode="ok";remoteTikTokStatus="PUBLISH_COMPLETE";holdTikTokRenewal=undefined;await db.prepare("DELETE FROM pin_failures").run();};

test("the editor's release form carries TikTok inline, with the send-now warning, and no options link",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({facebook:true,scheduledH:3});
  const html=await page(p.id);
  assert.match(html,/name="target_tiktok" value="1" checked/);
  assert.match(html,/Sent to your TikTok inbox the moment you approve<\/strong>, even though Facebook is scheduled for/);
  assert.match(html,/name="confirm_tiktok" value="1" required/);
  assert.match(html,/Approve selected targets/);
  assert.doesNotMatch(html,/\/tiktok-options/,"no separate TikTok options step for drafts");
  assert.doesNotMatch(html,/DIRECT_POST|Direct Post/);
  assert.equal(outbound.length,0,"rendering sends nothing");
});

test("photo carousel without a public title is blocked, not named after the internal draft",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft();
  await db.prepare("UPDATE posts SET tiktok_title=NULL WHERE id=?").bind(p.id).run();
  const html=await page(p.id);
  assert.doesNotMatch(html,/name="target_tiktok" value="1" checked/);
  assert.match(html,/Enter a public TikTok carousel title/);
  const r=await approve(p);
  assert.equal(r.status,400);
  assert.equal((await transfer(p.id)),null);
  assert.equal(tiktokCalls().length,0);
});

test("legacy TikTok send page never defaults to internal label, and rejects blank carousel titles",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft();
  await db.prepare("UPDATE posts SET tiktok_title=NULL WHERE id=?").bind(p.id).run();
  const raw=await makeSession(signer,"GSGrimoire");
  const options=await mf.dispatchFetch(ORIGIN+"/post/"+p.id+"/tiktok-options",
    {headers:{Cookie:SESSION_COOKIE+"="+raw}});
  assert.equal(options.status,200);
  const html=await options.text();
  assert.match(html,/name="tiktok_title" maxlength="90" value="" required/);
  assert.doesNotMatch(html,/name="tiktok_title"[^>]+value="Internal GS Poster title"/);
  const refused=await send("/post/"+p.id+"/tiktok-send",{
    expected_updated_at:p.updated_at,post_mode:"MEDIA_UPLOAD",media_type:"PHOTO",
    tiktok_caption:MSG,tiktok_title:"",confirm_tiktok:"1",pin:PIN,
  });
  assert.notEqual(refused.status,200);
  assert.match(await refused.text(),/Enter a public TikTok carousel title/);
  assert.equal(await transfer(p.id),null);
  assert.equal(tiktokCalls().length,0);
});

test("autosaving a TikTok draft sends nothing",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft();
  const r=await send("/post/"+p.id+"/save",{expected_updated_at:p.updated_at,p_tiktok:"1",message:MSG+" Edited."});
  assert.equal(r.status,200);
  assert.equal(outbound.length,0);
  assert.equal(await transfer(p.id),null);
});

test("TikTok only: one PIN sends exactly one inbox transfer and publishes nothing",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({photos:3});
  const r=await approve(p);
  const html=await r.text();
  assert.equal(r.status,200,html.slice(0,400));
  assert.match(html,/3-photo carousel sent to your TikTok inbox now/);
  assert.doesNotMatch(html,/TikTok[^.]*published/i);
  assert.equal(tiktokCalls().length,1);
  assert.match(tiktokCalls()[0].url,/\/v2\/post\/publish\/content\/init\/$/);
  assert.equal(facebookCalls().length,0);
  const t=await transfer(p.id);
  assert.equal(t?.status,"processing");
  assert.equal(t?.media_type,"PHOTO");
  const approved=(await getPost(db,p.id))!;
  assert.equal(approved.status,"scheduled","a PIN-approved TikTok-only transfer moves out of Drafts");
  assert.ok(approved.approved_at,"approval is recorded, even though TikTok publication remains manual");
  assert.equal(approved.scheduled_at,null,"TikTok inbox is not a provider schedule");
  assert.match(await page(p.id),/TikTok Inbox/);
  // A second click (same form) cannot send again.
  outbound.length=0;
  const again=await approve(p);
  assert.equal(again.status,409);
  assert.match(await again.text(),/Only drafts can be approved/);
  assert.equal(tiktokCalls().length,0);
});

test("TikTok video: the private MP4 goes to the inbox once",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({video:true});
  const r=await approve(p);
  const body=await r.text();
  assert.equal(r.status,200,(body.match(/role="alert">([^<]*)/)||["","?"])[1]+" | calls: "+JSON.stringify(tiktokCalls()));
  assert.deepEqual(tiktokCalls().map(c=>c.method+" "+new URL(c.url).pathname),
    ["POST /v2/post/publish/inbox/video/init/","PUT /video/"]);
  assert.equal((await transfer(p.id))?.status,"transfer_complete");
  assert.equal((await getPost(db,p.id))!.status,"scheduled");
});

test("Facebook scheduled + TikTok: TikTok now, Facebook queued, both reported, no Graph call",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({facebook:true,scheduledH:3});
  const r=await approve(p,{target_facebook:"1"});
  const html=await r.text();
  assert.equal(r.status,200,html.slice(0,400));
  assert.match(html,/TikTok: 3-photo carousel sent to your TikTok inbox now/);
  assert.match(html,/Facebook: /);
  assert.equal(tiktokCalls().length,1);
  assert.equal(facebookCalls().length,0,"photo posts go to the cron queue; nothing in the request");
  const after=(await getPost(db,p.id))!;
  assert.equal(after.status,"publishing");
  assert.equal(after.scheduled_at,p.scheduled_at,"TikTok does not move the Facebook date");
  const job=await db.prepare("SELECT status FROM facebook_upload_jobs WHERE post_id=?").bind(p.id).first<{status:string}>();
  assert.equal(job?.status,"uploading");
  assert.equal((await transfer(p.id))?.status,"processing");
});

test("TikTok refused: Facebook still approved, both outcomes shown, nothing retried",async()=>{
  await reset();await connectTikTok();tiktokMode="reject";
  const p=await ttDraft({facebook:true,scheduledH:3});
  const r=await approve(p,{target_facebook:"1"});
  const html=await r.text();
  assert.equal(r.status,200);
  assert.match(html,/TikTok: [^<]*refused|TikTok: [^<]*spam_risk/i);
  assert.match(html,/Facebook: /);
  assert.equal(tiktokCalls().length,1,"one attempt, no retry");
  assert.equal((await transfer(p.id))?.status,"rejected");
  assert.equal((await getPost(db,p.id))!.status,"publishing");
});

test("TikTok outcome unclear: recorded for review, and a later approval cannot resend",async()=>{
  await reset();await connectTikTok();tiktokMode="network";
  const p=await ttDraft();
  const r=await approve(p);
  assert.equal(r.status,502);
  assert.equal((await transfer(p.id))?.status,"needs_review");
  assert.equal((await getPost(db,p.id))!.status,"scheduled","uncertain transfer remains in History for human reconciliation");
  tiktokMode="ok";outbound.length=0;
  const again=await approve(p);
  assert.equal(again.status,409);
  assert.equal(tiktokCalls().length,0);
});

test("no TikTok transfer before every gate passes",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({facebook:true,scheduledH:3});
  const cases:[string,Promise<Response>,number][]=[
    ["no consent",send("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_tiktok:"1",target_facebook:"1",pin:PIN}),400],
    ["wrong PIN",approve(p,{target_facebook:"1",pin:"000000"}),403],
    ["stale page",approve({id:p.id,updated_at:"2020-01-01T00:00:00.000Z"},{target_facebook:"1"}),409],
    ["cross-site",send("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_tiktok:"1",confirm_tiktok:"1",pin:PIN},{origin:"https://evil.example"}),403],
    ["forged CSRF",send("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_tiktok:"1",confirm_tiktok:"1",pin:PIN},{csrf:"forged"}),403],
  ];
  for(const [name,res,code] of cases){
    const r=await res;await r.arrayBuffer();
    assert.equal(r.status,code,name);
    await db.prepare("DELETE FROM pin_failures").run();
  }
  // A Facebook problem found before sending stops TikTok too.
  const close=await ttDraft({facebook:true,scheduledH:0.05});
  const c=await approve(close,{target_facebook:"1"});
  assert.equal(c.status,400);
  assert.equal(outbound.length,0,"nothing reached TikTok or Facebook");
  assert.equal(await transfer(p.id),null);
  assert.equal((await getPost(db,p.id))!.status,"draft");
});

test("TikTok not connected, or without inbox permission: refused before anything is sent",async()=>{
  await reset();await db.prepare("DELETE FROM tiktok_accounts").run();
  const p=await ttDraft();
  assert.match(await page(p.id),/Connect TikTok first/);
  const r=await approve(p);
  assert.equal(r.status,400);
  assert.match(await r.text(),/Connect TikTok first/);
  await connectTikTok("user.info.basic");
  const q=await ttDraft();
  const r2=await approve(q);
  assert.equal(r2.status,400);
  assert.match(await r2.text(),/inbox upload permission/);
  assert.equal(outbound.length,0);
});

test("unticking TikTok releases Facebook alone and sends nothing to TikTok",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({facebook:true,scheduledH:3});
  const r=await send("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:PIN});
  assert.equal(r.status,200);
  assert.equal(tiktokCalls().length,0);
  assert.equal(await transfer(p.id),null);
  assert.equal((await getPost(db,p.id))!.status,"publishing");
});

const legacySend = (p: {id:string;updated_at:string}, video = false) =>
  send("/post/"+p.id+(video ? "/tiktok-upload" : "/tiktok-send"),{
    expected_updated_at:p.updated_at,post_mode:"MEDIA_UPLOAD",media_type:"PHOTO",
    tiktok_caption:MSG,tiktok_title:"Public goblin gallery",confirm_tiktok:"1",pin:PIN,
  });
const checkTikTokStatus = (p: {id:string}) => send("/post/"+p.id+"/tiktok-status",{pin:PIN});

test("standalone legacy TikTok transfer leaves Drafts and requires provider confirmation to publish",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({scheduledH:3});
  const sent=await legacySend(p);
  assert.equal(sent.status,200);
  assert.match(await sent.text(),/TikTok Inbox/);
  assert.equal((await getPost(db,p.id))!.scheduled_at,null);
  assert.equal(await markTikTokCreatorPublished(db,p.id),false);
  const checked=await checkTikTokStatus(p);
  assert.equal(checked.status,200);
  assert.match(await checked.text(),/Published by creator on TikTok/);
  assert.equal((await getPost(db,p.id))!.status,"published");
});

test("separate TikTok photo and video transfers preserve every unapproved sibling and its schedule",async()=>{
  await reset();await connectTikTok();
  for(const sibling of ["facebook","bluesky","instagram","threads"] as const){
    for(const video of [false,true]){
      const p=await ttDraft({facebook:sibling==="facebook",scheduledH:3,video});
      if(sibling==="bluesky") await db.prepare(
        "INSERT INTO bluesky_targets (post_id,caption) VALUES (?,?)").bind(p.id,MSG).run();
      if(sibling==="instagram") await db.prepare(
        "INSERT INTO instagram_targets (post_id,caption,frame) VALUES (?,?,'4:5')").bind(p.id,MSG).run();
      if(sibling==="threads") await db.prepare(
        "INSERT INTO threads_targets (post_id,caption,media) VALUES (?,?,'none')").bind(p.id,MSG).run();
      const before=await getPost(db,p.id);
      const sent=await legacySend(p,video);
      assert.equal(sent.status,200,sibling);
      assert.doesNotMatch(await sent.text(),/s-scheduled">TikTok Inbox/);
      assert.ok((await transfer(p.id))?.publish_id);
      assert.equal((await checkTikTokStatus(p)).status,200);
      assert.equal((await transfer(p.id))?.status,"published_by_creator");
      assert.deepEqual(await getPost(db,p.id),before,sibling+" keeps its draft and selected targets");
    }
  }
  assert.equal(facebookCalls().length,0);
});

test("an uncertain separate TikTok transfer preserves a mixed draft and blocks a second transfer",async()=>{
  await reset();await connectTikTok();tiktokMode="network";
  for(const video of [false,true]){
    const p=await ttDraft({facebook:true,scheduledH:3,video});
    const first=await legacySend(p,video);
    assert.equal(first.status,409);
    assert.equal((await transfer(p.id))?.status,"needs_review");
    assert.deepEqual(await getPost(db,p.id),p);
    const calls=tiktokCalls().length;
    assert.equal((await legacySend(p,video)).status,409);
    assert.equal(tiktokCalls().length,calls);
  }
});

test("choosing only TikTok on the inline approval leaves other enabled targets awaiting approval",async()=>{
  await reset();await connectTikTok();
  const p=await ttDraft({facebook:true,scheduledH:3});
  assert.equal((await approve(p)).status,200);
  assert.equal((await transfer(p.id))?.status,"processing");
  assert.deepEqual(await getPost(db,p.id),p);
  const later=await approve(p,{target_facebook:"1",target_tiktok:"0"});
  assert.equal(later.status,200);
  assert.equal((await getPost(db,p.id))!.status,"publishing");
  assert.equal(tiktokCalls().length,1);
});

test("a terminal TikTok failure can return to drafts and an edited retry needs fresh approval",async()=>{
  await reset();await connectTikTok();remoteTikTokStatus="FAILED";
  const p=await ttDraft();
  assert.equal((await approve(p)).status,200);
  const originalTransfer=await transfer(p.id);
  assert.equal((await checkTikTokStatus(p)).status,200);
  assert.equal((await transfer(p.id))?.status,"failed");
  const scheduled=(await getPost(db,p.id))!;
  assert.match(await page(p.id),/Move TikTok post back to drafts/);
  const recover=(version:string,pin=PIN)=>send("/post/"+p.id+"/tiktok-redraft",{expected_updated_at:version,pin});
  assert.equal((await recover(scheduled.updated_at,"000000")).status,403);
  assert.equal((await recover(p.updated_at)).status,409);
  assert.equal((await recover(scheduled.updated_at)).status,200);
  const draft=(await getPost(db,p.id))!;
  assert.equal(draft.status,"draft");
  assert.equal(draft.approved_at,null);
  assert.equal((await transfer(p.id))?.publish_id,originalTransfer?.publish_id);
  assert.equal((await send("/post/"+p.id+"/save",{expected_updated_at:draft.updated_at,p_tiktok:"1",
    tiktok_title:"Corrected goblin gallery",message:MSG+" Edited."})).status,200);
  const edited=(await getPost(db,p.id))!;
  assert.equal((await approve(edited,{pin:"000000"})).status,403);
  assert.equal(tiktokCalls().filter(call=>call.url.endsWith("/init/")).length,1);
  assert.equal((await approve(edited)).status,200);
  assert.notEqual((await transfer(p.id))?.publish_id,originalTransfer?.publish_id);
  assert.equal(tiktokCalls().filter(call=>call.url.endsWith("/init/")).length,2);
});

test("a draft save during TikTok preflight prevents the stale transfer and cannot approve the new draft",async()=>{
  await reset();await connectTikTok();
  await db.prepare("UPDATE tiktok_accounts SET access_expires_at=0").run();
  let arrived!: () => void, release!: () => void;
  const reached=new Promise<void>(resolve=>{arrived=resolve;});
  const pause=new Promise<void>(resolve=>{release=resolve;});
  holdTikTokRenewal=async()=>{arrived();await pause;};
  const p=await ttDraft();
  const sending=legacySend(p);
  try {
    await reached;
    assert.equal((await send("/post/"+p.id+"/save",{expected_updated_at:p.updated_at,p_tiktok:"1",
      tiktok_title:"Edited title",message:MSG+" Edited."})).status,200);
  } finally { release(); }
  assert.equal((await sending).status,409);
  assert.equal(tiktokCalls().filter(call=>call.url.endsWith("/init/")).length,0);
  assert.equal(await transfer(p.id),null);
  assert.equal((await getPost(db,p.id))!.status,"draft");
  assert.match(await page(p.id),/Edited title/);
});
