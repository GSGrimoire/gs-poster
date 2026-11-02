// Issue #61, part A: autosave, Post now, earliest valid time and opt-in
// rollover. Rules are unit-tested; routes run through the real bundled
// handleWeb in workerd. Only Facebook photo posts (cron queue, no Graph call)
// and Bluesky scheduling (no network until cron) are approved here, so no test
// can publish anything.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import {decideReleaseTime,earliestValidTime,minLeadFor,EDITOR_BUFFER_MS,ROLLOVER_BUFFER_MS} from "../src/schedule.ts";
import {DRAFT_EDITOR_JS} from "../src/draft-editor.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="autosave-test-cookie-secret";
const PIN="246810"; // test-only value
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const IMG=(n:number)=>"https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/"+n+".png";
const MIN=60e3;
let mf:Miniflare,db:D1Database;

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:out.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

async function post(path:string,fields:Record<string,string>,o:{auto?:boolean;origin?:string;login?:string|null;csrf?:string}={}){
  const headers:Record<string,string>={Origin:o.origin??ORIGIN,"Sec-Fetch-Site":o.origin&&o.origin!==ORIGIN?"cross-site":"same-origin",
    "Content-Type":"application/x-www-form-urlencoded"};
  if(o.auto)headers["X-GS-Autosave"]="1";
  let csrf=o.csrf;
  if(o.login!==null){
    const raw=await makeSession(signer,o.login??"GSGrimoire");
    headers.Cookie=SESSION_COOKIE+"="+raw;
    csrf??=await csrfToken(signer,{login:o.login??"GSGrimoire",raw} as Session);
  }
  return mf.dispatchFetch(ORIGIN+path,{method:"POST",headers,body:new URLSearchParams({csrf:csrf??"",...fields}).toString(),redirect:"manual"});
}
async function get(path:string,login:string|null="GSGrimoire"){
  const headers:Record<string,string>={};
  if(login)headers.Cookie=SESSION_COOKIE+"="+await makeSession(signer,login);
  return mf.dispatchFetch(ORIGIN+path,{headers,redirect:"manual"});
}
async function photoDraft(minutesAhead:number|null,images=2){
  return createPost(db,{message:"Goblins. Free in the Archive: patreon.com/GSGrimoire",label:"Goblins",release:"NPC",
    images:Array.from({length:images},(_,i)=>IMG(i)),video:null,created_by:"test",
    scheduled_at:minutesAhead===null?null:new Date(Date.now()+minutesAhead*MIN).toISOString(),
    facebook_enabled:true,tiktok_enabled:false,bluesky:null} as any);
}

// ------------------------------------------------------------ rules
test("lead times are unchanged: 30 min for Facebook photo posts, 12 otherwise",()=>{
  assert.equal(minLeadFor({facebook:true,photos:1}),30*MIN);
  assert.equal(minLeadFor({facebook:true,photos:0}),12*MIN);
  assert.equal(minLeadFor({facebook:false,photos:5}),12*MIN,"Bluesky-only photos do not use the Facebook queue");
});

test("earliest valid time is rounded up to five minutes and always clears lead plus buffer",()=>{
  const now=new Date("2026-11-02T14:03:17.000Z");
  const t=earliestValidTime(now,{facebook:true,photos:3},EDITOR_BUFFER_MS);
  assert.equal(t.toISOString(),"2026-11-02T14:45:00.000Z");
  assert.equal(t.getUTCMinutes()%5,0);
  assert.ok(t.getTime()-now.getTime()>=30*MIN+EDITOR_BUFFER_MS);
  // Across the Copenhagen daylight-saving change (25 Oct 2026, 03:00 -> 02:00 local).
  const dst=earliestValidTime(new Date("2026-10-25T00:52:00.000Z"),{facebook:false,photos:0},ROLLOVER_BUFFER_MS);
  const local=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Copenhagen",minute:"2-digit"}).format(dst);
  assert.equal(Number(local)%5,0);
});

test("release time: post now stays now; too close is refused unless the owner opted in",()=>{
  const now=new Date("2026-11-02T14:00:00.000Z");
  const lead={facebook:true,photos:2};
  assert.deepEqual(decideReleaseTime(null,now,lead,true),{ok:true,when:null},"rollover never turns Post now into a schedule");
  const fine=new Date("2026-11-02T15:00:00.000Z");
  assert.deepEqual(decideReleaseTime(fine,now,lead,true),{ok:true,when:fine},"a valid time is never moved");
  const close=new Date("2026-11-02T14:20:00.000Z");
  const refused=decideReleaseTime(close,now,lead,false);
  assert.equal(refused.ok,false);
  if(!refused.ok){assert.match(refused.error,/30 minutes/);assert.equal(refused.suggestion!.toISOString(),"2026-11-02T14:35:00.000Z");}
  const moved=decideReleaseTime(close,now,lead,true);
  assert.ok(moved.ok&&moved.when!.toISOString()==="2026-11-02T14:35:00.000Z"&&moved.movedFrom===close);
  const far=decideReleaseTime(new Date(now.getTime()+31*24*60*MIN),now,lead,true);
  assert.equal(far.ok,false,"31 days out is refused, not moved");
});

// ------------------------------------------------------------ autosave route
test("autosave saves through the same fence and answers JSON",async()=>{
  const p=await photoDraft(120);
  const r=await post("/post/"+p.id+"/save",{expected_updated_at:p.updated_at,p_facebook:"1",message:"Edited by autosave. Free in the Archive: patreon.com/GSGrimoire"},{auto:true});
  assert.equal(r.status,200);
  const body=await r.json() as any;
  assert.equal(body.ok,true);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.updated_at,body.updated_at);
  assert.match(saved.message,/Edited by autosave/);
  assert.equal(saved.status,"draft");
  assert.equal(saved.approved_at,null,"saving never approves");
  // The old version is now stale: refused, nothing changes.
  const stale=await post("/post/"+p.id+"/save",{expected_updated_at:p.updated_at,p_facebook:"1",message:"Lost edit"},{auto:true});
  assert.equal(stale.status,409);
  const sb=await stale.json() as any;
  assert.equal(sb.ok,false);
  assert.equal(sb.current_updated_at,body.updated_at);
  assert.match((await getPost(db,p.id))!.message,/Edited by autosave/);
});

test("autosave cannot touch an approved post, and keeps every outer gate",async()=>{
  const p=await photoDraft(120);
  await db.prepare("UPDATE posts SET status='scheduled',approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id).run();
  const cur=(await getPost(db,p.id))!;
  const r=await post("/post/"+p.id+"/save",{expected_updated_at:cur.updated_at,p_facebook:"1",message:"Sneaky"},{auto:true});
  assert.equal(r.status,409);
  assert.equal((await getPost(db,p.id))!.message,p.message);
  const q=await photoDraft(120);
  const fields={expected_updated_at:q.updated_at,p_facebook:"1",message:"Sneaky"};
  assert.equal((await post("/post/"+q.id+"/save",fields,{auto:true,origin:"https://evil.example"})).status,403);
  assert.equal((await post("/post/"+q.id+"/save",fields,{auto:true,csrf:"forged"})).status,403);
  const anon=await post("/post/"+q.id+"/save",fields,{auto:true,login:null});
  assert.notEqual(anon.status,200);
  const stranger=await post("/post/"+q.id+"/save",fields,{auto:true,login:"someone-else"});
  assert.notEqual(stranger.status,200);
  assert.equal((await getPost(db,q.id))!.message,q.message);
});

test("two autosaves from the same version: exactly one is saved",async()=>{
  const p=await photoDraft(120);
  const [a,b]=await Promise.all(["A","B"].map(x=>post("/post/"+p.id+"/save",
    {expected_updated_at:p.updated_at,p_facebook:"1",message:"Version "+x+". Free in the Archive: patreon.com/GSGrimoire"},{auto:true})));
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
});

// ------------------------------------------------------------ earliest time
test("earliest-time comes from the server clock and needs a session",async()=>{
  const anon=await get("/earliest-time?facebook=1&photos=3",null);
  assert.notEqual(anon.status,200);
  await anon.arrayBuffer();
  const before=Date.now();
  const r=await get("/earliest-time?facebook=1&photos=3");
  assert.equal(r.status,200);
  const body=await r.json() as any;
  const at=Date.parse(body.iso);
  assert.ok(at-before>=40*MIN,"30-minute photo lead plus the 10-minute editor buffer");
  assert.match(body.local,/^\d{4}-\d\d-\d\dT\d\d:\d[05]$/);
  const text=await get("/earliest-time?facebook=0&photos=0").then(x=>x.json()) as any;
  assert.ok(Date.parse(text.iso)-Date.now()<30*MIN);
});

// ------------------------------------------------------------ rollover at approval
test("too-close time without the opt-in: refused with the earliest valid time, nothing changes",async()=>{
  await db.prepare("DELETE FROM pin_failures").run();
  const p=await photoDraft(5);
  const r=await post("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:PIN});
  assert.equal(r.status,400);
  const html=await r.text();
  assert.match(html,/earliest valid time now is/);
  assert.match(html,/Automatically move to the next valid time/);
  const after=(await getPost(db,p.id))!;
  assert.equal(after.status,"draft");
  assert.equal(after.scheduled_at,p.scheduled_at);
});

test("with the opt-in, the time moves inside the approval claim and is audited",async()=>{
  await db.prepare("DELETE FROM pin_failures").run();
  const p=await photoDraft(5);
  const t0=Date.now();
  const r=await post("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:PIN,auto_rollover:"1"});
  assert.equal(r.status,200,await r.clone().text());
  assert.match(await r.text(),/because that time was too close, as you allowed/);
  const after=(await getPost(db,p.id))!;
  assert.equal(after.status,"publishing","photo post entered the durable queue; no Graph call in the request");
  const moved=Date.parse(after.scheduled_at!);
  assert.ok(moved-t0>=30*MIN,"moved to at least the photo lead");
  assert.equal(new Date(moved).getUTCMinutes()%5,0);
  const log=await db.prepare("SELECT detail FROM audit WHERE post_id=? AND action='schedule-rolled-over'").bind(p.id).first<{detail:string}>();
  assert.ok(log?.detail.startsWith(p.scheduled_at!+" -> "));
});

test("the opt-in never moves a valid time, and never helps a wrong PIN or a stale page",async()=>{
  await db.prepare("DELETE FROM pin_failures").run();
  const ok=await photoDraft(120);
  const r=await post("/post/"+ok.id+"/approve",{expected_updated_at:ok.updated_at,target_facebook:"1",pin:PIN,auto_rollover:"1"});
  assert.equal(r.status,200);
  assert.equal((await getPost(db,ok.id))!.scheduled_at,ok.scheduled_at);
  const close=await photoDraft(5);
  assert.equal((await post("/post/"+close.id+"/approve",{expected_updated_at:close.updated_at,target_facebook:"1",pin:"000000",auto_rollover:"1"})).status,403);
  assert.equal((await post("/post/"+close.id+"/approve",{expected_updated_at:"2020-01-01T00:00:00.000Z",target_facebook:"1",pin:PIN,auto_rollover:"1"})).status,409);
  const still=(await getPost(db,close.id))!;
  assert.equal(still.status,"draft");
  assert.equal(still.scheduled_at,close.scheduled_at);
  await db.prepare("DELETE FROM pin_failures").run();
});

// ------------------------------------------------------------ editor page
test("editor offers Post now, Earliest valid time and the opt-in, and no 15-minute shortcut",async()=>{
  const p=await photoDraft(120);
  const html=await (await get("/post/"+p.id)).text();
  assert.match(html,/id="ed-now"/);
  assert.match(html,/id="ed-earliest"/);
  assert.doesNotMatch(html,/In 15 minutes/);
  assert.match(html,/name="auto_rollover" value="1">/);
  assert.doesNotMatch(html,/name="auto_rollover" value="1" checked/,"off by default");
  assert.match(html,/Changes save automatically/);
  const now=await photoDraft(null);
  const nowHtml=await (await get("/post/"+now.id)).text();
  assert.doesNotMatch(nowHtml,/name="auto_rollover"/,"no rollover box when posting on approval");
  assert.match(nowHtml,/upload queue/);
  assert.match(DRAFT_EDITOR_JS,/X-GS-Autosave/);
  assert.doesNotThrow(()=>new Function(DRAFT_EDITOR_JS));
});
