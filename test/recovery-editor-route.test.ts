// PR #52 review (31 Oct): a post recovered to drafts must be an ordinary,
// unapproved draft that the owner can edit, re-time and release again with a
// fresh PIN. Every step runs through the real handleWeb in workerd.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {STUCK_PUBLISHING_MS} from "../src/publish.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="recovery-test-cookie-secret";
const PIN="864201"; // test-only value
let mf:Miniflare,db:D1Database;
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
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

async function post(path:string,fields:Record<string,string>){
  const raw=await makeSession(signer,"GSGrimoire");
  const body=new URLSearchParams({csrf:await csrfToken(signer,{login:"GSGrimoire",raw} as Session),...fields});
  await db.prepare("DELETE FROM pin_failures").run();
  return mf.dispatchFetch(ORIGIN+path,{method:"POST",redirect:"manual",body:body.toString(),headers:{
    Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",Cookie:SESSION_COOKIE+"="+raw,"Content-Type":"application/x-www-form-urlencoded"}});
}
async function page(id:string){
  const raw=await makeSession(signer,"GSGrimoire");
  return (await mf.dispatchFetch(ORIGIN+"/post/"+id,{headers:{Cookie:SESSION_COOKIE+"="+raw}})).text();
}
const now=async(id:string)=>(await getPost(db,id))!;
const job=(id:string)=>db.prepare("SELECT status,next_index,media_ids FROM facebook_upload_jobs WHERE post_id=?").bind(id)
  .first<{status:string;next_index:number;media_ids:string}>();
const localIn=(h:number)=>{
  const d=new Date(Date.now()+h*3600e3);
  const p=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Copenhagen",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d);
  return p.replace(" ","T");
};

/** Owner edits the recovered draft and releases it again through the web. */
async function editAndRelease(id:string,images:number){
  const html=await page(id);
  assert.match(html,/id="draft-editor"/,"recovered post opens in the editor");
  const d=await now(id);
  const saved=await post("/post/"+id+"/save",{expected_updated_at:d.updated_at,p_facebook:"1",
    ...(d.bluesky?{p_bluesky:"1",bs_caption:"New Bluesky text #GSGrimoire"}:{}),
    message:MSG+" Edited after recovery.",when:localIn(3)});
  assert.equal(saved.status,200,await saved.clone().text());
  const e=await now(id);
  assert.equal(e.message,MSG+" Edited after recovery.");
  assert.ok(e.scheduled_at&&Date.parse(e.scheduled_at)>Date.now()+2*3600e3);
  assert.equal(e.approved_at,null);
  // A fresh approval is required: no PIN, no release.
  const fields={expected_updated_at:e.updated_at,target_facebook:"1",...(e.bluesky?{target_bluesky:"1"}:{}),
    ...(images>12?{reviewed_all_images:"1"}:{})};
  assert.equal((await post("/post/"+id+"/approve",{...fields,pin:"000000"})).status,403);
  assert.equal((await now(id)).status,"draft");
  const ok=await post("/post/"+id+"/approve",{...fields,pin:PIN});
  assert.equal(ok.status,200,await ok.clone().text());
  const r=await now(id);
  assert.equal(r.status,"publishing");
  assert.ok(r.approved_at);
  assert.equal(r.message,MSG+" Edited after recovery.");
  const j=(await job(id))!;
  assert.equal(j.status,"uploading");
  assert.equal(j.next_index,0);
  assert.equal(j.media_ids,"[]");
  if(r.bluesky)assert.equal(r.bluesky.status,"scheduled");
}

for(const n of [1,7,11]){
  test(`abandoned ${n}-photo queue: redraft revokes approval, then edit, re-time and fresh PIN release`,async()=>{
    const p=await createPost(db,{message:MSG,images:Array.from({length:n},(_,i)=>IMG(i)),video:null,created_by:"test",
      scheduled_at:null,facebook_enabled:true,tiktok_enabled:false,bluesky:null});
    const a=await post("/post/"+p.id+"/approve",{expected_updated_at:p.updated_at,target_facebook:"1",pin:PIN});
    assert.equal(a.status,200);
    assert.equal((await now(p.id)).status,"publishing");
    // Cron fails part-way (simulated), then the owner abandons the queue.
    await db.prepare("UPDATE facebook_upload_jobs SET status='failed',next_index=1,media_ids='[\"m0\"]',error='boom' WHERE post_id=?").bind(p.id).run();
    assert.equal((await post("/post/"+p.id+"/abandon-facebook",{expected_updated_at:(await now(p.id)).updated_at,pin:PIN})).status,200);
    const f=await now(p.id);
    assert.equal(f.status,"failed");
    assert.equal((await job(p.id))?.status,"cancelled");
    // Redraft needs the PIN, the Facebook check and the current version.
    assert.equal((await post("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,pin:PIN})).status,400);
    assert.equal((await post("/post/"+p.id+"/redraft",{expected_updated_at:"2020-01-01T00:00:00.000Z",confirmed_no_facebook:"1",pin:PIN})).status,409);
    const rd=await post("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1",pin:PIN});
    assert.ok([200,302,303].includes(rd.status));
    const d=await now(p.id);
    assert.equal(d.status,"draft");
    assert.equal(d.approved_at,null,"old approval revoked");
    assert.equal(d.error,null);
    await editAndRelease(p.id,n);
  });
}

test("stuck publishing post: reconcile-stuck, redraft clears the past time, edit and release",async()=>{
  const p=await createPost(db,{message:MSG,images:Array.from({length:7},(_,i)=>IMG(i)),video:null,created_by:"test",
    scheduled_at:new Date(Date.now()-5*86400e3).toISOString(),facebook_enabled:true,tiktok_enabled:false,bluesky:null});
  const old=new Date(Date.now()-STUCK_PUBLISHING_MS-60e3).toISOString();
  await db.prepare("UPDATE posts SET status='publishing',approved_at=?,updated_at=? WHERE id=?").bind(old,old,p.id).run();
  const s=await post("/post/"+p.id+"/reconcile-stuck",{expected_updated_at:old,confirmed_no_facebook:"1",pin:PIN});
  assert.equal(s.status,200);
  const f=await now(p.id);
  assert.equal(f.status,"failed");
  const rd=await post("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1",pin:PIN});
  assert.ok([200,302,303].includes(rd.status));
  const d=await now(p.id);
  assert.equal(d.status,"draft");
  assert.equal(d.approved_at,null);
  assert.equal(d.scheduled_at,null,"a schedule that has passed is cleared");
  assert.equal(await job(p.id),null);
  await editAndRelease(p.id,7);
});

test("a future schedule survives redraft so the owner can keep or change it",async()=>{
  const p=await createPost(db,{message:MSG,images:[IMG(1),IMG(2)],video:null,created_by:"test",
    scheduled_at:new Date(Date.now()+5*3600e3).toISOString(),facebook_enabled:true,tiktok_enabled:false,bluesky:null});
  await db.prepare("UPDATE posts SET status='failed',approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id).run();
  const f=await now(p.id);
  await post("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1",pin:PIN});
  const d=await now(p.id);
  assert.equal(d.status,"draft");
  assert.equal(d.scheduled_at,p.scheduled_at);
});

test("combined Facebook + failed Bluesky: redraft resets both, edit both, release both",async()=>{
  const p=await createPost(db,{message:MSG,images:[IMG(1),IMG(2),IMG(3)],video:null,created_by:"test",scheduled_at:null,
    facebook_enabled:true,tiktok_enabled:false,bluesky:{caption:"Old Bluesky #GSGrimoire",images:[],video:null,patreon:null}});
  await db.batch([
    db.prepare("UPDATE posts SET status='failed',approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id),
    db.prepare("UPDATE bluesky_targets SET status='failed',error='x' WHERE post_id=?").bind(p.id),
  ]);
  const f=await now(p.id);
  await post("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1",pin:PIN});
  const d=await now(p.id);
  assert.equal(d.status,"draft");
  assert.equal(d.approved_at,null);
  assert.equal(d.bluesky?.status,"draft");
  assert.equal(d.bluesky?.error,null);
  await editAndRelease(p.id,3);
  assert.equal((await now(p.id)).bluesky?.caption,"New Bluesky text #GSGrimoire");
});

test("an active or published Bluesky target, or a Facebook id, still blocks redraft",async()=>{
  for(const [bs,fb] of [["scheduled",null],["published",null],["failed","476872498846005_1"]] as const){
    const p=await createPost(db,{message:MSG,images:[IMG(1)],video:null,created_by:"test",scheduled_at:null,
      facebook_enabled:true,tiktok_enabled:false,bluesky:{caption:"B",images:[],video:null,patreon:null}});
    await db.batch([
      db.prepare("UPDATE posts SET status='failed',approved_at=?,fb_post_id=? WHERE id=?").bind(new Date().toISOString(),fb,p.id),
      db.prepare("UPDATE bluesky_targets SET status=? WHERE post_id=?").bind(bs,p.id),
    ]);
    const f=await now(p.id);
    assert.equal((await post("/post/"+p.id+"/redraft",{expected_updated_at:f.updated_at,confirmed_no_facebook:"1",pin:PIN})).status,409);
    const after=await now(p.id);
    assert.equal(after.status,"failed");
    assert.ok(after.approved_at);
  }
});


/** An approved Instagram job is independent of a Facebook failure, even when
 * Facebook's record is restored to an ordinary draft. A redraft must not
 * silently revoke the visible approval while that job can still publish. */
test("issue #85: Facebook redraft is refused with every pending Instagram job state",async()=>{
  for(const status of ["scheduled","preparing","processing","sending","failed"]){
    for(const ambiguous of status==="failed" ? [0,1] : [0]){
      const due=new Date(Date.now()+4*3600_000).toISOString();
      const p=await createPost(db,{message:MSG,images:[],video:null,created_by:"test",
        scheduled_at:due,facebook_enabled:true,tiktok_enabled:false,bluesky:null});
      const approved=new Date().toISOString();
      await db.prepare("UPDATE posts SET status='failed',approved_at=?,fb_post_id=NULL WHERE id=?")
        .bind(approved,p.id).run();
      await db.prepare(`INSERT INTO instagram_jobs
        (post_id,status,kind,due_at,caption,frame,items,created_by,updated_at,ambiguous)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(p.id,status,"IMAGE",due,"Approved Instagram photo","4:5","[]","GSGrimoire",approved,ambiguous).run();
      const before=await now(p.id);
      // This recovery deliberately does not supply a PIN, in accordance with
      // the owner-approved no-send recovery rule.
      const res=await post("/post/"+p.id+"/redraft",{
        expected_updated_at:before.updated_at,confirmed_no_facebook:"1"});
      assert.equal(res.status,409,status+" ambiguous="+ambiguous);
      assert.match(await res.text(),/PIN-approved Instagram job/);
      const after=await now(p.id);
      assert.equal(after.status,"failed");
      assert.equal(after.approved_at,approved,"approval has not been revoked");
      assert.equal(after.scheduled_at,due,"schedule not silently cleared");
      assert.equal(after.updated_at,before.updated_at,"version not advanced");
      const job=await db.prepare("SELECT status,ambiguous,due_at FROM instagram_jobs WHERE post_id=?")
        .bind(p.id).first<{status:string;ambiguous:number;due_at:string}>();
      assert.equal(job?.status,status);
      assert.equal(job?.ambiguous,ambiguous);
      assert.equal(job?.due_at,due);
    }
  }
});

test("issue #85: once Instagram is cancelled, Facebook failure can be redrafted",async()=>{
  const due=new Date(Date.now()+3600_000).toISOString();
  const p=await createPost(db,{message:MSG,images:[],video:null,created_by:"test",
    scheduled_at:due,facebook_enabled:true,tiktok_enabled:false,bluesky:null});
  const approved=new Date().toISOString();
  await db.prepare("UPDATE posts SET status='failed',approved_at=? WHERE id=?").bind(approved,p.id).run();
  await db.prepare(`INSERT INTO instagram_jobs
    (post_id,status,kind,due_at,caption,frame,items,created_by,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(p.id,"scheduled","IMAGE",due,"Frozen","4:5","[]","GSGrimoire",approved).run();
  const before=await now(p.id);
  assert.equal((await post("/post/"+p.id+"/redraft",{
    expected_updated_at:before.updated_at,confirmed_no_facebook:"1"})).status,409);
  // Simulate a separate authorized Instagram cancellation that completed first.
  await db.prepare("UPDATE instagram_jobs SET status='cancelled' WHERE post_id=?").bind(p.id).run();
  const res=await post("/post/"+p.id+"/redraft",{
    expected_updated_at:before.updated_at,confirmed_no_facebook:"1"});
  assert.equal(res.status,302);
  const after=await now(p.id);
  assert.equal(after.status,"draft");
  assert.equal(after.approved_at,null);
  assert.equal(after.scheduled_at,due,"future schedule survives ordinary recovery");
});
