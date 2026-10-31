// One-page editor (owner decision 31 Oct 2026): drafts save without a PIN,
// release still needs the PIN and releases exactly the saved version.
// Everything runs through the real handleWeb bundled into workerd.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost,updatePost} from "../src/db.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="editor-test-cookie-secret";
const PIN="135790"; // test-only value
let mf:Miniflare,db:D1Database;
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const IMG=(n:number)=>"https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/"+n+".png";

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:out.outputFiles[0].text,compatibilityDate:"2026-09-01",
    compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

async function draft(o:{images?:number;bluesky?:boolean;tiktok?:boolean;inHours?:number}={}){
  return createPost(db,{message:"Four goblins. Free in the Archive: patreon.com/GSGrimoire",label:"Goblins",release:"NPC",
    images:Array.from({length:o.images??3},(_,i)=>IMG(i)),video:null,created_by:"test",
    scheduled_at:o.inHours?new Date(Date.now()+o.inHours*3600e3).toISOString():null,
    facebook_enabled:true,tiktok_enabled:!!o.tiktok,
    tiktok_images:o.tiktok?[IMG(7),IMG(8)]:undefined,
    bluesky:o.bluesky?{caption:"Goblins #GSGrimoire",images:[{url:IMG(0),alt:"A goblin"},{url:IMG(1),alt:"Another goblin"}],video:null,patreon:null}:null});
}
async function call(path:string,fields:Record<string,string>,o:{login?:string|null;origin?:string;csrf?:string}={}){
  const headers:Record<string,string>={Origin:o.origin??ORIGIN,"Sec-Fetch-Site":o.origin&&o.origin!==ORIGIN?"cross-site":"same-origin",
    "Content-Type":"application/x-www-form-urlencoded"};
  let csrf=o.csrf;
  if(o.login!==null){
    const raw=await makeSession(signer,o.login??"GSGrimoire");
    headers.Cookie=SESSION_COOKIE+"="+raw;
    csrf??=await csrfToken(signer,{login:o.login??"GSGrimoire",raw} as Session);
  }
  const body=new URLSearchParams({csrf:csrf??"",...fields});
  return mf.dispatchFetch(ORIGIN+path,{method:"POST",headers,body:body.toString(),redirect:"manual"});
}
async function get(path:string){
  const raw=await makeSession(signer,"GSGrimoire");
  return mf.dispatchFetch(ORIGIN+path,{headers:{Cookie:SESSION_COOKIE+"="+raw},redirect:"manual"});
}
const baseSave=(p:{updated_at:string})=>({expected_updated_at:p.updated_at,p_facebook:"1"});

test("the draft page is one editor: Save button, chosen platforms only, no duplicate caption forms",async()=>{
  const p=await draft({bluesky:true});
  const res=await get("/post/"+p.id);
  assert.equal(res.status,200);
  const html=await res.text();
  assert.match(html,/id="draft-editor"/);
  assert.match(html,/Save changes/);
  assert.match(html,/\+ Add photos/);
  assert.match(html,/\+ Add video/);
  assert.match(html,/Approve and post now/);
  assert.doesNotMatch(html,/Edit unreleased captions/);
  assert.doesNotMatch(html,/name="bs_image_0"/,"no raw Bluesky URL fields");
  assert.match(html,/data-platform="tiktok" hidden/);
  assert.equal((await get("/draft-editor.js")).status,200);
});

test("Save needs no PIN, changes text, name, time and platforms, and publishes nothing",async()=>{
  const p=await draft();
  const when="2031-05-04T18:30";
  const res=await call("/post/"+p.id+"/save",{...baseSave(p),p_tiktok:"1",p_bluesky:"1",
    message:"Edited Facebook text",bs_caption:"Short Bluesky",tiktok_caption:"TikTok #GSGrimoire",
    label:"Goblin gallery",release:"NPC galleries",when});
  assert.equal(res.status,200);
  assert.match(await res.text(),/Saved\. Nothing was published/);
  const after=(await getPost(db,p.id))!;
  assert.equal(after.status,"draft");
  assert.equal(after.approved_at,null);
  assert.equal(after.message,"Edited Facebook text");
  assert.equal(after.tiktok_enabled,true);
  assert.equal(after.tiktok_caption,"TikTok #GSGrimoire");
  assert.equal(after.bluesky?.caption,"Short Bluesky");
  assert.equal(after.bluesky?.status,"draft");
  assert.equal(after.label,"Goblin gallery");
  assert.equal(after.release,"NPC galleries");
  assert.equal(after.scheduled_at,"2031-05-04T16:30:00.000Z");
  const audit=await db.prepare("SELECT actor,detail FROM audit WHERE post_id=? AND action='edited'").bind(p.id).first<{actor:string;detail:string}>();
  assert.equal(audit?.actor,"GSGrimoire");
});

test("Save removes media and edits Bluesky descriptions, but cannot add media",async()=>{
  const p=await draft({images:4,bluesky:true,tiktok:true});
  const res=await call("/post/"+p.id+"/save",{...baseSave(p),p_bluesky:"1",p_tiktok:"1",
    remove_fb_1:"1",remove_bs_0:"1",bs_alt_1:"A grinning goblin with a blade",remove_tt_0:"1",
    bs_caption:"Goblins",images:JSON.stringify(["https://evil.example/x.png"]),bs_image_2:"https://evil.example/y.png"});
  assert.equal(res.status,200);
  const after=(await getPost(db,p.id))!;
  assert.deepEqual(after.images,[IMG(0),IMG(2),IMG(3)]);
  assert.deepEqual(after.bluesky?.images,[{url:IMG(1),alt:"A grinning goblin with a blade"}]);
  assert.deepEqual(after.tiktok_images,[IMG(8)]);
});

test("Save refuses a stale version, a non-draft, too-long text and no platforms, changing nothing",async()=>{
  const p=await draft({bluesky:true});
  assert.equal((await call("/post/"+p.id+"/save",{expected_updated_at:"2020-01-01T00:00:00.000Z",p_facebook:"1",message:"x"})).status,409);
  assert.equal((await call("/post/"+p.id+"/save",{...baseSave(p),p_bluesky:"1",bs_caption:"g".repeat(301)})).status,400);
  assert.equal((await call("/post/"+p.id+"/save",{expected_updated_at:p.updated_at,message:"x"})).status,400);
  assert.equal((await getPost(db,p.id))!.updated_at,p.updated_at);
  const sched=await draft();
  await updatePost(db,sched.id,{status:"scheduled",approved_at:new Date().toISOString()},["draft"]);
  const s=(await getPost(db,sched.id))!;
  assert.equal((await call("/post/"+s.id+"/save",{...baseSave(s),message:"changed"})).status,409);
  assert.equal((await getPost(db,s.id))!.message,sched.message);
});

test("a rejected post becomes a draft again when saved",async()=>{
  const p=await draft();
  await updatePost(db,p.id,{status:"rejected",note:"Shorter please"},["draft"]);
  const r=(await getPost(db,p.id))!;
  assert.equal((await call("/post/"+p.id+"/save",{...baseSave(r),message:"Shorter"})).status,200);
  assert.equal((await getPost(db,p.id))!.status,"draft");
});

test("Save is still gated by sign-in, allowlist, same-origin and CSRF",async()=>{
  const p=await draft();
  const r1=await call("/post/"+p.id+"/save",{...baseSave(p),message:"x"},{login:null});
  assert.ok([302,303].includes(r1.status));
  const r2=await call("/post/"+p.id+"/save",{...baseSave(p),message:"x"},{login:"stranger"});
  assert.ok([302,303].includes(r2.status));
  assert.equal((await call("/post/"+p.id+"/save",{...baseSave(p),message:"x"},{origin:"https://evil.example"})).status,403);
  assert.equal((await call("/post/"+p.id+"/save",{...baseSave(p),message:"x"},{csrf:"forged"})).status,403);
  assert.equal((await getPost(db,p.id))!.message,p.message);
});

test("Release uses the SAVED draft; forged caption and Bluesky fields in the form are ignored",async()=>{
  await db.prepare("DELETE FROM pin_failures").run();
  // 11 photos goes through the cron queue on every branch, so no Facebook call is made here.
  const p=await draft({images:11,inHours:3});
  const res=await call("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:PIN,
    message:"FORGED caption",when:"2026-01-01T00:00",target_bluesky:"1",bs_caption:"FORGED",bs_image_0:"https://evil.example/z.png",bs_alt_0:"x"});
  assert.equal(res.status,200,await res.clone().text());
  const after=(await getPost(db,p.id))!;
  assert.equal(after.status,"publishing");
  assert.equal(after.message,p.message);
  assert.equal(after.scheduled_at,p.scheduled_at);
  assert.equal(after.bluesky,null,"Bluesky was not saved, so it cannot be released");
  const job=await db.prepare("SELECT status FROM facebook_upload_jobs WHERE post_id=?").bind(p.id).first<{status:string}>();
  assert.equal(job?.status,"uploading");
});

test("Release still needs the PIN and the current version",async()=>{
  await db.prepare("DELETE FROM pin_failures").run();
  const p=await draft({images:2,inHours:3});
  assert.equal((await call("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:"000000"})).status,403);
  assert.equal((await call("/post/"+p.id+"/approve",{expected_updated_at:"2020-01-01T00:00:00.000Z",target_facebook:"1",pin:PIN})).status,409);
  assert.equal((await getPost(db,p.id))!.status,"draft");
  await db.prepare("DELETE FROM pin_failures").run();
});

test("Release refuses a saved time that is too close, pointing back to the editor",async()=>{
  await db.prepare("DELETE FROM pin_failures").run();
  const p=await createPost(db,{message:"Soon",images:[IMG(1)],video:null,created_by:"test",
    scheduled_at:new Date(Date.now()+5*60e3).toISOString(),facebook_enabled:true,tiktok_enabled:false,bluesky:null});
  const res=await call("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:PIN});
  assert.equal(res.status,400);
  assert.match(await res.text(),/Change the time in the editor and save/);
  assert.equal((await getPost(db,p.id))!.status,"draft");
});
