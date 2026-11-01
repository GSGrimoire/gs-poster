// Route-level gates for POST /post/:id/tiktok-clear, exercised through the real
// handleWeb bundled and run in workerd (Miniflare), not by calling the helper.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema} from "../src/db.ts";
import {ensureTikTokInboxSchema,getTikTokInboxTransfer} from "../src/tiktok-inbox.ts";
import {ensureTikTokMediaSchema} from "../src/tiktok-media.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="route-test-cookie-secret";
const PIN="246810"; // test-only value
let mf:Miniflare,db:D1Database;
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire,mallory-not"} as Env;

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:out.outputFiles[0].text,compatibilityDate:"2026-09-01",
    compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,
      TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);await ensureTikTokInboxSchema(db);await ensureTikTokMediaSchema(db);
});
after(async()=>{await mf?.dispose();});

/** An uncertain photo attempt: needs_review, no publish_id, live grants. */
async function uncertainPost(publishId:string|null=null){
  const p=await createPost(db,{message:"Carousel",images:[],video:null,created_by:"test",
    scheduled_at:null,facebook_enabled:false,tiktok_enabled:true,bluesky:null});
  const now=new Date().toISOString();
  await db.prepare("INSERT INTO tiktok_inbox_transfers (post_id,status,publish_id,media_ref,created_at,updated_at,sent_by,error,remote_status,post_mode,media_type) "+
    "VALUES (?,'needs_review',?,'[]',?,?,'GSGrimoire','uncertain',NULL,'MEDIA_UPLOAD','PHOTO')").bind(p.id,publishId,now,now).run();
  await db.prepare("INSERT INTO tiktok_media_grants (token_hash,post_id,media_ref,kind,expires_at,created_by) VALUES (?,?,?,?,?,?)")
    .bind("h_"+p.id,p.id,"upload://"+"d".repeat(32)+".jpg","image",Math.floor(Date.now()/1000)+3600,"GSGrimoire").run();
  return p.id;
}
const statusOf=async(id:string)=>(await getTikTokInboxTransfer(db,id))?.status;
const grantCount=async(id:string)=>(await db.prepare("SELECT COUNT(*) AS n FROM tiktok_media_grants WHERE post_id=?").bind(id).first<{n:number}>())!.n;

async function send(id:string,o:{login?:string|null;origin?:string;csrf?:string;pin?:string;confirm?:boolean}={}){
  const headers:Record<string,string>={"Origin":o.origin??ORIGIN,
    "Sec-Fetch-Site":o.origin&&o.origin!==ORIGIN?"cross-site":"same-origin"};
  let csrf=o.csrf;
  if(o.login!==null){
    const login=o.login??"GSGrimoire";
    const raw=await makeSession(signer,login);
    headers["Cookie"]=SESSION_COOKIE+"="+raw;
    csrf??=await csrfToken(signer,{login,raw} as Session);
  }
  const form=new URLSearchParams({csrf:csrf??"",pin:o.pin??PIN});
  if(o.confirm!==false)form.set("confirmed_not_on_tiktok","1");
  headers["Content-Type"]="application/x-www-form-urlencoded";
  return mf.dispatchFetch(ORIGIN+"/post/"+id+"/tiktok-clear",{method:"POST",headers,body:form.toString(),redirect:"manual"});
}

test("no session, or a login outside the allowlist, goes to sign-in and changes nothing",async()=>{
  const id=await uncertainPost();
  const anon=await send(id,{login:null});
  assert.ok([302,303].includes(anon.status));assert.match(anon.headers.get("Location")??"",/^\/login/);
  const other=await send(id,{login:"mallory-not"});
  assert.ok([302,303].includes(other.status));
  assert.equal(await statusOf(id),"needs_review");
  assert.equal(await grantCount(id),1);
});
test("cross-origin and forged CSRF are refused",async()=>{
  const id=await uncertainPost();
  assert.equal((await send(id,{origin:"https://evil.example"})).status,403);
  assert.equal((await send(id,{csrf:"forged"})).status,403);
  assert.equal(await statusOf(id),"needs_review");
});
test("missing confirmation, and a row that has a publish_id, are refused",async()=>{
  const id=await uncertainPost();
  assert.equal((await send(id,{confirm:false})).status,400);
  assert.equal(await statusOf(id),"needs_review");
  const withId=await uncertainPost("p_inbox~kept");
  assert.equal((await send(withId)).status,409);
  assert.equal(await statusOf(withId),"needs_review");
  assert.equal(await grantCount(withId),1);
});
test("a wrong PIN is refused, and lockout blocks even the right PIN",async()=>{
  const id=await uncertainPost();
  await db.prepare("DELETE FROM pin_failures").run();
  assert.equal((await send(id,{pin:"000000"})).status,403);
  for(let i=0;i<4;i++)await send(id,{pin:"000000"});
  assert.equal((await send(id)).status,429);
  assert.equal(await statusOf(id),"needs_review");
  await db.prepare("DELETE FROM pin_failures").run();
});
test("signed-in editor with PIN and confirmation clears it once, revoking grants",async()=>{
  const id=await uncertainPost();
  await db.prepare("DELETE FROM pin_failures").run();
  const ok=await send(id);
  assert.equal(ok.status,200);
  assert.match(await ok.text(),/cleared on your confirmation/);
  assert.equal(await statusOf(id),"cleared");
  assert.equal(await grantCount(id),0);
  const audit=await db.prepare("SELECT actor FROM audit WHERE post_id=? AND action='tiktok-transfer-cleared'").bind(id).first<{actor:string}>();
  assert.equal(audit?.actor,"GSGrimoire");
  assert.equal((await send(id)).status,409);
});

test("a hand-made Direct Post form is refused while Direct Post is hidden",async()=>{
  const p=await createPost(db,{message:"Carousel",images:[],video:null,created_by:"test",
    scheduled_at:null,facebook_enabled:false,tiktok_enabled:true,bluesky:null});
  await db.prepare("DELETE FROM pin_failures").run();
  const raw=await makeSession(signer,"GSGrimoire");
  const form=new URLSearchParams({csrf:await csrfToken(signer,{login:"GSGrimoire",raw} as Session),pin:PIN,
    confirm_tiktok:"1",confirm_direct:"1",post_mode:"DIRECT_POST",media_type:"PHOTO",privacy_level:"SELF_ONLY",
    expected_updated_at:p.updated_at});
  const res=await mf.dispatchFetch(ORIGIN+"/post/"+p.id+"/tiktok-send",{method:"POST",redirect:"manual",
    headers:{Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",Cookie:SESSION_COOKIE+"="+raw,
      "Content-Type":"application/x-www-form-urlencoded"},body:form.toString()});
  assert.equal(res.status,400);
  assert.match(await res.text(),/Direct Post is switched off/);
  assert.equal(await getTikTokInboxTransfer(db,p.id),null);
});
