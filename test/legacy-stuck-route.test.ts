// Live acceptance on 1 Nov 2026 found seven stuck posts with status
// 'publishing' but approved_at = NULL. GS Poster v0.1.0 claimed the post
// before uploading and wrote approved_at only after Facebook answered, so a
// request that died mid-upload left this shape. They must be recoverable
// through the same PIN-gated path, without backfilling an approval and
// without any outbound request. Runs the real handleWeb in workerd.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {ensureFacebookQueue} from "../src/facebook-queue.ts";
import {STUCK_PUBLISHING_MS} from "../src/publish.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="legacy-test-cookie-secret";
const PIN="975310"; // test-only value
let mf:Miniflare,db:D1Database;
const outbound:string[]=[];
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const IMG=(n:number)=>"https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/"+n+".png";
const MSG="Five ways to open a campaign. Free in the Archive: patreon.com/GSGrimoire";

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:out.outputFiles[0].text,compatibilityDate:"2026-09-01",
    compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    // Every outbound request from the Worker is recorded and refused.
    outboundService:(req:Request)=>{outbound.push(req.url);return new Response("blocked in test",{status:599});},
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);await ensureFacebookQueue(db);
});
after(async()=>{await mf?.dispose();});

async function send(path:string,fields:Record<string,string>,o:{login?:string|null;origin?:string;csrf?:string;keepPinFailures?:boolean}={}){
  const headers:Record<string,string>={Origin:o.origin??ORIGIN,"Sec-Fetch-Site":o.origin&&o.origin!==ORIGIN?"cross-site":"same-origin",
    "Content-Type":"application/x-www-form-urlencoded"};
  let csrf=o.csrf;
  if(o.login!==null){
    const login=o.login??"GSGrimoire";
    const raw=await makeSession(signer,login);
    headers.Cookie=SESSION_COOKIE+"="+raw;
    csrf??=await csrfToken(signer,{login,raw} as Session);
  }
  if(!o.keepPinFailures)await db.prepare("DELETE FROM pin_failures").run();
  return mf.dispatchFetch(ORIGIN+path,{method:"POST",redirect:"manual",headers,
    body:new URLSearchParams({csrf:csrf??"",...fields}).toString()});
}
async function page(id:string){
  const raw=await makeSession(signer,"GSGrimoire");
  return (await mf.dispatchFetch(ORIGIN+"/post/"+id,{headers:{Cookie:SESSION_COOKIE+"="+raw}})).text();
}
const cur=async(id:string)=>(await getPost(db,id))!;

/** The exact production shape of p_mvppbkvn27705754cc. */
async function legacy(o:{ageMs?:number;fbId?:string;bluesky?:string;job?:boolean}={}){
  const p=await createPost(db,{message:MSG,images:Array.from({length:7},(_,i)=>IMG(i)),video:null,created_by:"test",
    scheduled_at:"2026-10-27T18:00:00.000Z",facebook_enabled:true,tiktok_enabled:false,
    bluesky:o.bluesky?{caption:"B",images:[],video:null,patreon:null}:null});
  const old=new Date(Date.now()-(o.ageMs??STUCK_PUBLISHING_MS+3600e3)).toISOString();
  await db.prepare("UPDATE posts SET status='publishing',approved_at=NULL,fb_post_id=?,updated_at=? WHERE id=?")
    .bind(o.fbId??null,old,p.id).run();
  if(o.bluesky)await db.prepare("UPDATE bluesky_targets SET status=? WHERE post_id=?").bind(o.bluesky,p.id).run();
  if(o.job)await db.prepare("INSERT INTO facebook_upload_jobs (post_id,status) VALUES (?,'failed')").bind(p.id).run();
  return (await getPost(db,p.id))!;
}
const reconcile=(p:{id:string;updated_at:string},extra:Record<string,string>={},o={})=>
  send("/post/"+p.id+"/reconcile-stuck",{expected_updated_at:p.updated_at,confirmed_no_facebook:"1",pin:PIN,...extra},o);

test("the legacy record shows the recovery form, with a note about the older version",async()=>{
  const p=await legacy();
  assert.equal(p.approved_at,null);
  const html=await page(p.id);
  assert.match(html,/This approval stopped before GS Poster recorded a Facebook result/);
  assert.match(html,/Mark as failed \(sends nothing\)/);
  assert.match(html,/older version of GS Poster/);
});

test("refused without sign-in, allowlisted login, same origin, CSRF or the Facebook confirmation",async()=>{
  const p=await legacy();
  assert.ok([302,303].includes((await reconcile(p,{},{login:null})).status));
  assert.ok([302,303].includes((await reconcile(p,{},{login:"stranger"})).status));
  assert.equal((await reconcile(p,{},{origin:"https://evil.example"})).status,403);
  assert.equal((await reconcile(p,{},{csrf:"forged"})).status,403);
  assert.equal((await send("/post/"+p.id+"/reconcile-stuck",{expected_updated_at:p.updated_at})).status,400);
  assert.equal((await cur(p.id)).status,"publishing");
});

// Owner decision, 1 Nov 2026: the two recovery steps send nothing, so no PIN.
test("Mark as failed and Move back to drafts need no PIN; the forms do not ask for one",async()=>{
  const p=await legacy();
  const html=await page(p.id);
  const stuckForm=html.slice(html.indexOf('action="/post/'+p.id+'/reconcile-stuck"'));
  assert.doesNotMatch(stuckForm.slice(0,stuckForm.indexOf("</form>")),/name="pin"/);
  const r=await send("/post/"+p.id+"/reconcile-stuck",{expected_updated_at:p.updated_at,confirmed_no_facebook:"1"});
  assert.equal(r.status,200);
  const f=await cur(p.id);
  assert.equal(f.status,"failed");
  const failedHtml=await page(p.id);
  const redraftForm=failedHtml.slice(failedHtml.indexOf('action="/post/'+p.id+'/redraft"'));
  assert.doesNotMatch(redraftForm.slice(0,redraftForm.indexOf("</form>")),/name="pin"/);
  const rd=await send("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1"});
  assert.ok([200,302,303].includes(rd.status));
  const d=await cur(p.id);
  assert.equal(d.status,"draft");
  assert.equal(d.approved_at,null);
  // Releasing it still needs the PIN.
  assert.equal((await send("/post/"+p.id+"/approve",{expected_updated_at:d.updated_at,target_facebook:"1"})).status,403);
  assert.equal((await cur(p.id)).status,"draft");
});

test("a PIN lockout does not block recovery, but still blocks approval",async()=>{
  const p=await legacy();
  await db.prepare("DELETE FROM pin_failures").run();
  for(let i=0;i<5;i++)await send("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,pin:"000000"},{keepPinFailures:true});
  assert.equal((await reconcile(p,{},{keepPinFailures:true})).status,200);
  const f=await cur(p.id);
  const rd=await send("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1"},{keepPinFailures:true});
  assert.ok([200,302,303].includes(rd.status));
  const d=await cur(p.id);
  assert.equal(d.status,"draft");
  assert.equal((await send("/post/"+p.id+"/approve",{expected_updated_at:d.updated_at,target_facebook:"1",pin:PIN},{keepPinFailures:true})).status,429);
  assert.equal((await cur(p.id)).status,"draft");
  await db.prepare("DELETE FROM pin_failures").run();
});

test("refused for a recent post, a stale version, a Facebook id, a queue job or an active/published Bluesky",async()=>{
  const cases=[
    await legacy({ageMs:STUCK_PUBLISHING_MS-60e3}),
    await legacy({fbId:"476872498846005_1"}),
    await legacy({job:true}),
    await legacy({bluesky:"scheduled"}),
    await legacy({bluesky:"publishing"}),
    await legacy({bluesky:"published"}),
  ];
  for(const p of cases){
    assert.equal((await reconcile(p)).status,409,p.id);
    assert.equal((await cur(p.id)).status,"publishing");
  }
  const s=await legacy();
  assert.equal((await reconcile(s,{expected_updated_at:"2020-01-01T00:00:00.000Z"})).status,409);
  assert.equal((await cur(s.id)).status,"publishing");
});

test("full recovery: failed -> draft -> save -> fresh PIN approval into the queue, with no outbound request",async()=>{
  outbound.length=0;
  const p=await legacy();
  const r=await reconcile(p);
  assert.equal(r.status,200);
  const f=await cur(p.id);
  assert.equal(f.status,"failed");
  assert.equal(f.approved_at,null,"no approval is invented");
  assert.match(f.error??"",/older GS Poster version/);
  const audit=await db.prepare("SELECT actor,detail FROM audit WHERE post_id=? AND action='stuck-publishing-reconciled'").bind(p.id).all<{actor:string;detail:string}>();
  assert.equal(audit.results.length,1);
  assert.equal(audit.results[0].actor,"GSGrimoire");
  assert.match(audit.results[0].detail,/legacy record without approved_at/);
  // A second submission of the same form does nothing.
  assert.equal((await reconcile(p)).status,409);

  const rd=await send("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1",pin:PIN});
  assert.ok([200,302,303].includes(rd.status));
  const d=await cur(p.id);
  assert.equal(d.status,"draft");
  assert.equal(d.approved_at,null);
  assert.equal(d.scheduled_at,null,"the 27 Oct slot has passed and is cleared");
  assert.match(await page(p.id),/id="draft-editor"/);

  const saved=await send("/post/"+p.id+"/save",{expected_updated_at:d.updated_at,p_facebook:"1",message:MSG+" Re-run."});
  assert.equal(saved.status,200);
  const e=await cur(p.id);
  assert.equal(e.status,"draft");
  assert.equal(e.approved_at,null,"saving never approves");

  const fields={expected_updated_at:e.updated_at,target_facebook:"1"};
  assert.equal((await send("/post/"+p.id+"/approve",{...fields,pin:"000000"})).status,403);
  assert.equal((await send("/post/"+p.id+"/approve",fields)).status,403);
  assert.equal((await cur(p.id)).status,"draft");
  const ok=await send("/post/"+p.id+"/approve",{...fields,pin:PIN});
  assert.equal(ok.status,200,await ok.clone().text());
  const a=await cur(p.id);
  assert.equal(a.status,"publishing");
  assert.ok(a.approved_at,"approved only now, by the fresh PIN approval");
  assert.equal(a.message,MSG+" Re-run.");
  const job=await db.prepare("SELECT status,next_index,media_ids FROM facebook_upload_jobs WHERE post_id=?").bind(p.id)
    .first<{status:string;next_index:number;media_ids:string}>();
  assert.deepEqual({...job},{status:"uploading",next_index:0,media_ids:"[]"});
  assert.deepEqual(outbound,[],"nothing was sent to Facebook or anywhere else");
});

test("two simultaneous reconcile submissions: exactly one succeeds and one audit entry is written",async()=>{
  const p=await legacy();
  await db.prepare("DELETE FROM pin_failures").run();
  const [a,b]=await Promise.all([reconcile(p,{},{keepPinFailures:true}),reconcile(p,{},{keepPinFailures:true})]);
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
  const n=await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE post_id=? AND action='stuck-publishing-reconciled'").bind(p.id).first<{n:number}>();
  assert.equal(n?.n,1);
  assert.equal((await cur(p.id)).status,"failed");
});

test("control: the outbound recorder really catches Worker requests",async()=>{
  const seen:string[]=[];
  const probe=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,compatibilityDate:"2026-09-01",
    script:"export default {async fetch(){const r=await fetch('https://graph.facebook.com/v24.0/me');return new Response(String(r.status));}}",
    outboundService:(req:Request)=>{seen.push(req.url);return new Response("x",{status:599});}}));
  try{
    assert.equal(await (await probe.dispatchFetch("http://probe/")).text(),"599");
    assert.deepEqual(seen,["https://graph.facebook.com/v24.0/me"]);
  }finally{await probe.dispose();}
});
