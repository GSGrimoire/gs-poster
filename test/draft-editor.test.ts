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
  assert.match(html,/id="preflight-panel"/);
  assert.match(html,/id="preflight-stale"/);
  assert.match(html,/\+ Add photos/);
  assert.match(html,/\+ Add video/);
  assert.match(html,/Approve and post now/);
  assert.doesNotMatch(html,/Edit unreleased captions/);
  assert.doesNotMatch(html,/name="bs_image_0"/,"no raw Bluesky URL fields");
  assert.match(html,/data-platform="tiktok" hidden/);
  assert.ok(html.includes(".targets > .target[hidden],.readiness > li[hidden]{display:none!important}"),
    "inactive cards and readiness entries must stay hidden despite display:grid/flex rules");
  assert.equal((await get("/draft-editor.js")).status,200);
});

test("disabling and re-enabling a platform retains its captions and gallery without approval",async()=>{
  const p=await draft({bluesky:true});
  const item={url:IMG(0),mode:"crop",cx:0.5,cy:0.5,zoom:1,bg:"dark"};
  const enabled=await call("/post/"+p.id+"/save",{...baseSave(p),p_bluesky:"1",p_instagram:"1",
    bs_caption:"Saved Bluesky words",ig_caption:"Saved Instagram words",ig_frame:"4:5",
    ig_items:JSON.stringify([item])});
  assert.equal(enabled.status,200,await enabled.clone().text());
  const active=(await getPost(db,p.id))!;
  assert.equal(active.bluesky?.caption,"Saved Bluesky words");
  assert.equal(active.instagram?.items.length,1);

  const paused=await call("/post/"+p.id+"/save",{...baseSave(active),message:"Facebook only"});
  assert.equal(paused.status,200,await paused.clone().text());
  const off=(await getPost(db,p.id))!;
  assert.equal(off.bluesky,null,"paused target must never appear as an active publishing target");
  assert.equal(off.instagram,null);
  assert.equal(off.bluesky_paused?.caption,"Saved Bluesky words");
  assert.deepEqual(off.bluesky_paused?.images,active.bluesky?.images);
  assert.equal(off.instagram_paused?.caption,"Saved Instagram words");
  assert.deepEqual(off.instagram_paused?.items,[item]);
  const page=await (await get("/post/"+p.id)).text();
  assert.match(page,/id="target-bluesky" data-platform="bluesky" hidden/);
  assert.match(page,/id="target-instagram" data-platform="instagram" hidden/);
  assert.doesNotMatch(page,/name="target_bluesky"/,"paused Bluesky must not be offered for approval");
  assert.equal((await call("/post/"+p.id+"/approve",
    {expected_updated_at:off.updated_at,target_bluesky:"1",pin:PIN})).status,400);
  assert.equal((await getPost(db,p.id))!.approved_at,null);

  const resumed=await call("/post/"+p.id+"/save",
    {...baseSave(off),p_bluesky:"1",p_instagram:"1"});
  assert.equal(resumed.status,200,await resumed.clone().text());
  const restored=(await getPost(db,p.id))!;
  assert.equal(restored.bluesky?.caption,"Saved Bluesky words");
  assert.deepEqual(restored.bluesky?.images,active.bluesky?.images);
  assert.deepEqual(restored.instagram?.items,[item]);
  assert.equal(restored.instagram?.caption,"Saved Instagram words");
});

test("TikTok uses a public title and gets a separate image gallery after late activation",async()=>{
  const p=await draft({images:2});
  const selected=await call("/post/"+p.id+"/save",
    {...baseSave(p),p_facebook:"1",p_tiktok:"1",tiktok_title:"The Goblin Gallery"});
  assert.equal(selected.status,200,await selected.clone().text());
  const joined=(await getPost(db,p.id))!;
  assert.equal(joined.tiktok_title,"The Goblin Gallery");
  assert.equal(joined.label,"Goblins","internal label must remain separate");
  assert.deepEqual(joined.tiktok_images,p.images,"existing Facebook photos are copied on activation");
  assert.notEqual(joined.tiktok_images,null,"TikTok no longer shares mutations with Facebook");
  const trim=await call("/post/"+p.id+"/save",
    {...baseSave(joined),p_facebook:"1",p_tiktok:"1",remove_tt_0:"1"});
  assert.equal(trim.status,200,await trim.clone().text());
  const changed=(await getPost(db,p.id))!;
  assert.deepEqual(changed.images,p.images,"removing a TikTok image must not change Facebook media");
  assert.deepEqual(changed.tiktok_images,[p.images[1]]);

  const copied=await call("/post/"+p.id+"/save",
    {...baseSave(changed),p_facebook:"1",p_tiktok:"1",tt_copy_fb:"1"});
  assert.equal(copied.status,200,await copied.clone().text());
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,p.images);
  const html=await (await get("/post/"+p.id)).text();
  assert.match(html,/name="tiktok_title"/);
  assert.match(html,/value="The Goblin Gallery"/);
  assert.match(html,/id="tt-copy-fb"/);
  assert.match(html,/data-index="0" draggable="true"/);
  const js=await (await get("/draft-editor.js")).text();
  assert.match(js,/dragstart/);
  assert.match(js,/ig-drag/);
  const saved=(await getPost(db,p.id))!;
  const disabled=await call("/post/"+p.id+"/save",{...baseSave(saved)});
  assert.equal(disabled.status,200,await disabled.clone().text());
  const off=(await getPost(db,p.id))!;
  assert.equal(off.tiktok_enabled,false);
  assert.equal(off.tiktok_title,"The Goblin Gallery");
  assert.deepEqual(off.tiktok_images,p.images,"deselection must keep TikTok photos");
  assert.doesNotMatch(await (await get("/post/"+p.id)).text(),/name="target_tiktok"/,
    "deselected TikTok must not be offered for approval");
  const enabled=await call("/post/"+p.id+"/save",{...baseSave(off),p_tiktok:"1"});
  assert.equal(enabled.status,200,await enabled.clone().text());
  const restored=(await getPost(db,p.id))!;
  assert.equal(restored.tiktok_enabled,true);
  assert.equal(restored.tiktok_title,"The Goblin Gallery");
  assert.deepEqual(restored.tiktok_images,p.images);
});

test("TikTok copies an existing Facebook video without changing Facebook or publishing",async()=>{
  const facebookVideo="https://raw.githubusercontent.com/GSGrimoire/GSImageLibrary/main/videos/creature.mp4";
  const p=await createPost(db,{
    message:"Video of a creature",label:"Internal only",images:[],video:facebookVideo,
    tiktok_images:[IMG(5),IMG(6)],tiktok_video:null,tiktok_enabled:true,facebook_enabled:true,
    created_by:"test",scheduled_at:null,bluesky:null,
  });
  const page=await (await get("/post/"+p.id)).text();
  assert.match(page,/id="tt-copy-fb-video"/,"independent TikTok drafts offer copying a Facebook video");
  assert.match(page,/name="tt_copy_fb" id="tt-copy-fb-flag" value="0"/,
    "the copy action exists even when Facebook has no photos");
  assert.doesNotMatch(page,/id="tt-copy-fb"/,"no Facebook photos, so photo-copy option is absent");
  const js=await (await get("/draft-editor.js")).text();
  assert.match(js,/tt-copy-fb-video/);
  assert.ok(js.includes('if (!confirm(question)) return;'),
    "the shared TikTok copy helper requires explicit confirmation");
  assert.ok(js.includes('copyFacebookMediaToTikTok("Replace TikTok photos or video with the Facebook video?'),
    "the video-copy action supplies its own confirmation prompt");

  const attemptedRemoval=await call("/post/"+p.id+"/save",{
    ...baseSave(p),p_tiktok:"1",tt_copy_fb:"1",remove_fb_video:"1",
  });
  assert.equal(attemptedRemoval.status,400,"copy must not silently use a removed Facebook video");
  assert.equal((await getPost(db,p.id))!.video,facebookVideo,"failed copy leaves Facebook unchanged");
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,[IMG(5),IMG(6)]);
  const response=await call("/post/"+p.id+"/save",{
    ...baseSave(p),p_tiktok:"1",tt_copy_fb:"1",
  });
  assert.equal(response.status,200,await response.clone().text());
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.video,facebookVideo,"Facebook video must remain unchanged");
  assert.deepEqual(saved.images,[],"Facebook gallery must remain unchanged");
  assert.deepEqual(saved.tiktok_images,[],"video replaces TikTok-only photos");
  assert.equal(saved.tiktok_video,facebookVideo,"TikTok gets its own video reference");
  assert.equal(saved.status,"draft");
  assert.equal(saved.approved_at,null,"saving/copying video must never approve or publish");
  assert.equal(saved.label,"Internal only");

  const stale=await call("/post/"+p.id+"/save",{
    ...baseSave(p),p_tiktok:"1",tt_copy_fb:"1",
  });
  assert.equal(stale.status,409,"version fence still applies to media copy");
  const now=(await getPost(db,p.id))!;
  assert.equal(now.updated_at,saved.updated_at);

  const paused=await call("/post/"+p.id+"/save",{...baseSave(now),p_facebook:"1"});
  assert.equal(paused.status,200,await paused.clone().text());
  const inactive=(await getPost(db,p.id))!;
  assert.equal(inactive.tiktok_enabled,false);
  assert.equal(inactive.tiktok_video,facebookVideo,"disabled TikTok retains video without being published");
  assert.equal(inactive.video,facebookVideo);
  assert.equal(inactive.approved_at,null);
});

test("copying Facebook video replaces an independently saved TikTok video only",async()=>{
  const fb="https://raw.githubusercontent.com/GSGrimoire/GSImageLibrary/main/videos/facebook.mp4";
  const oldTikTok="https://raw.githubusercontent.com/GSGrimoire/GSImageLibrary/main/videos/tiktok.mp4";
  const p=await createPost(db,{
    message:"Two independent videos",images:[],video:fb,tiktok_images:[],tiktok_video:oldTikTok,
    facebook_enabled:true,tiktok_enabled:true,created_by:"test",scheduled_at:null,bluesky:null,
  });
  const updated=await call("/post/"+p.id+"/save",{
    ...baseSave(p),p_facebook:"1",p_tiktok:"1",tt_copy_fb:"1",
  });
  assert.equal(updated.status,200,await updated.clone().text());
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.tiktok_video,fb,"TikTok video is replaced by saved Facebook source");
  assert.deepEqual(saved.tiktok_images,[],"independent TikTok gallery stays video only");
  assert.equal(saved.video,fb,"Facebook video is unchanged");
  assert.equal(saved.approved_at,null);
  assert.equal(saved.status,"draft");
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
  assert.match(await res.text(),/Change the time in the editor/);
  assert.equal((await getPost(db,p.id))!.status,"draft");
});

test("rejected draft has a direct return action in editor and dashboard",async()=>{
  const p=await draft({bluesky:true});
  await db.prepare("UPDATE posts SET status='rejected',note=? WHERE id=?")
    .bind("Revise the caption",p.id).run();
  const rejected=(await getPost(db,p.id))!;
  const editor=await (await get("/post/"+p.id)).text();
  assert.match(editor,/Return rejected post to drafts/);
  assert.match(editor,new RegExp('action="/post/'+p.id+'/return-to-drafts"'));
  assert.match(editor,/Revise the caption/);
  const dashboard=await (await get("/")).text();
  assert.match(dashboard,new RegExp('action="/post/'+p.id+'/return-to-drafts"'));
  const res=await call("/post/"+p.id+"/return-to-drafts",{expected_updated_at:rejected.updated_at});
  assert.equal(res.status,302,await res.clone().text());
  const restored=(await getPost(db,p.id))!;
  assert.equal(restored.status,"draft");
  assert.equal(restored.approved_at,null);
  assert.equal(restored.note,"Revise the caption","reviewer feedback remains available");
  assert.deepEqual(restored.bluesky?.images,rejected.bluesky?.images);
  assert.deepEqual(restored.images,rejected.images);
  assert.equal((await call("/post/"+p.id+"/return-to-drafts",
    {expected_updated_at:restored.updated_at})).status,409,"cannot replay after return");
});

test("return rejected draft refuses forged, stale, cross-origin or approved requests",async()=>{
  const p=await draft();
  await db.prepare("UPDATE posts SET status='rejected' WHERE id=?").bind(p.id).run();
  const rejected=(await getPost(db,p.id))!;
  const endpoint="/post/"+p.id+"/return-to-drafts";
  const fields={expected_updated_at:rejected.updated_at};
  assert.equal((await call(endpoint,fields,{csrf:"invalid-csrf"})).status,403);
  assert.equal((await call(endpoint,fields,{origin:"https://other.example"})).status,403);
  assert.equal((await call(endpoint,{expected_updated_at:"2020-01-01T00:00:00.000Z"})).status,409);
  assert.equal((await getPost(db,p.id))!.status,"rejected");
  await db.prepare("UPDATE posts SET approved_at=? WHERE id=?")
    .bind(new Date().toISOString(),p.id).run();
  assert.equal((await call(endpoint,fields)).status,409);
  assert.equal((await getPost(db,p.id))!.approved_at===null,false);
});

test("authenticated planner routes switch between week and month without changing a post",async()=>{
  const p=await draft({images:3,inHours:3});
  const chosen=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Copenhagen",year:"numeric",month:"2-digit"})
    .format(new Date(p.scheduled_at!));
  const target=chosen.slice(0,7);
  const result=await get("/calendar?view=month&month="+target);
  assert.equal(result.status,200);
  const html=await result.text();
  assert.match(html,/calendar-month-grid/);
  assert.match(html,/aria-current="page">Month/);
  assert.match(html,new RegExp('href="/post/'+p.id+'"'));
  assert.match(html,new RegExp('src="/media/'+p.id+'/0\\?thumb=1&amp;platform=facebook"'));
  assert.doesNotMatch(html,/class="calendar-slot"/,"month has no time slots");
  const week=await get("/calendar?view=week&week="+target+"-01");
  assert.equal(week.status,200);
  assert.match(await week.text(),/class="calendar-now" hidden/);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.status,"draft");
  assert.equal(saved.approved_at,null);
});
