// Real workerd router, real D1, and no external-provider calls.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost,audit} from "../src/db.ts";
import {searchPosts,searchActivity,reconcileOldTikTokInboxDrafts,markTikTokInboxApproved} from "../src/history.ts";
import {ensureTikTokInboxSchema} from "../src/tiktok-inbox.ts";
import {makeSession,SESSION_COOKIE} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="history-test-only-secret";
const SIGNER={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
let mf:Miniflare,db:D1Database;
const created:{drafts:string[];scheduled:string[];published:string[];failed:string[]}={
  drafts:[],scheduled:[],published:[],failed:[]
};

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:out.outputFiles[0].text,compatibilityDate:"2026-09-01",
    compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",
      APPROVE_PIN:"428915",TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureTikTokInboxSchema(db);
  for(const [status,count] of [["draft",45],["scheduled",25],["published",24],["failed",6]] as const){
    for(let n=0;n<count;n++){
      const p=await createPost(db,{message:"History sample "+status+" "+n,
        label:status+" record "+n,release:"Historic campaign",images:[],video:null,
        created_by:"test",facebook_enabled:true,tiktok_enabled:false,bluesky:null,
        scheduled_at:status==="scheduled"?new Date(Date.now()+n*60_000).toISOString():null});
      if(status!=="draft"){
        await db.prepare("UPDATE posts SET status=?,approved_at=? WHERE id=?")
          .bind(status,new Date().toISOString(),p.id).run();
      }
      created[status==="draft"?"drafts":status==="scheduled"?"scheduled":status==="published"?"published":"failed"].push(p.id);
    }
  }
  const marked=await createPost(db,{message:"Unique search needle",label:"Special archive item",
    release:"Searchable",images:[],video:null,created_by:"test",facebook_enabled:false,
    tiktok_enabled:false,bluesky:null,scheduled_at:null});
  await db.prepare("UPDATE posts SET status='published',approved_at=? WHERE id=?")
    .bind(new Date().toISOString(),marked.id).run();
  for(let i=0;i<47;i++)await audit(db,"test","history-check-"+i,i===0?marked.id:null,"audit detail "+i);
});
after(async()=>{await mf?.dispose();});

async function get(path:string,authenticated=true){
  const headers:Record<string,string>={};
  if(authenticated){
    const raw=await makeSession(SIGNER,"GSGrimoire");
    headers.Cookie=SESSION_COOKIE+"="+raw;
  }
  return mf.dispatchFetch(ORIGIN+path,{headers,redirect:"manual"});
}

test("only drafts appear on the planner; 20 per collapsible page",async()=>{
  const res=await get("/");
  assert.equal(res.status,200);
  const html=await res.text();
  assert.match(html,/<details class="history-section" id="drafts" open>/);
  assert.match(html,/Drafts<\/span><span class="history-count">45<\/span>/);
  assert.match(html,/Showing 1 to 20 of 45/);
  assert.match(html,/drafts_page=2/);
  assert.doesNotMatch(html,/id="scheduled" open>/,"scheduled posts belong on History");
  assert.doesNotMatch(html,/id="published" open>/,"published posts belong on History");
  assert.doesNotMatch(html,/id="activity" open>/,"activity belongs on History");
  assert.match(html,/href="\/history"/);
  const second=await (await get("/?drafts_page=2")).text();
  assert.match(second,/Showing 21 to 40 of 45/);
  assert.match(second,/drafts_page=3/);
  assert.doesNotMatch(second,/Showing 1 to 20 of 45/);
});

test("History has independent collapsible pagers for scheduled, published, other and activity",async()=>{
  const html=await (await get("/history")).text();
  for(const id of ["scheduled","published","other","activity"]){
    assert.match(html,new RegExp('<details class="history-section" id="'+id+'" open>'));
  }
  assert.match(html,/Scheduled \/ In Inbox/);
  assert.match(html,/Showing 1 to 20 of 25/);
  assert.match(html,/Showing 1 to 20 of 47/);
  assert.match(html,/scheduled_page=2/);
  assert.match(html,/published_page=2/);
  assert.match(html,/activity_page=2/);
  assert.doesNotMatch(html,/<details class="history-section" id="drafts" open>/);
  const page2=await (await get("/history?activity_page=2&published_page=2")).text();
  assert.match(page2,/Showing 21 to 40 of 47/);
  assert.match(page2,/Showing 21 to 25 of 25/);
});

test("search covers the full history, including captions and activity, without wildcard injection",async()=>{
  const found=await searchPosts(db,"published","Unique search needle");
  assert.equal(found.total,1);
  assert.match(found.items[0].message,/Unique search needle/);
  assert.equal((await searchPosts(db,"published","not-found")).total,0);
  assert.equal((await searchPosts(db,"drafts","%")).total,0,"percent is literal, not a wildcard");
  assert.equal((await searchActivity(db,"history-check-0")).total,1);
  const html=await (await get("/history?q=Unique%20search%20needle")).text();
  assert.match(html,/Special archive item/);
  assert.match(html,/value="Unique search needle"/);
  assert.match(html,/No scheduled or inbox posts match this search/);
  const xss=await (await get("/history?q="+encodeURIComponent('"><img src=x onerror=alert(1)>'))).text();
  assert.doesNotMatch(xss,/value=""><img src=x/);
  assert.match(xss,/&#34;&#62;&#60;img/);
});

test("History and private drafts require a signed-in owner; the favicon is public",async()=>{
  const res=await get("/history",false);
  assert.equal(res.status,302);
  assert.match(res.headers.get("location")??"",/\/login\?next=/);
  const svg=await get("/favicon.svg",false);
  assert.equal(svg.status,200);
  assert.match(svg.headers.get("content-type")??"",/image\/svg\+xml/);
  const icon=await svg.text();
  assert.match(icon,/<svg/);
  assert.match(icon,/#a6221c/);
  assert.match(icon,/megaphone|path/);
  assert.doesNotMatch(icon,/<script/);
  assert.match((await (await get("/")).text()),/rel="icon" type="image\/svg\+xml"/);
});

test("legacy TikTok-only transfers move out of drafts, without publishing or changing mixed targets",async()=>{
  const make=async(name:string,facebook:boolean,status:string)=>{
    const p=await createPost(db,{message:name,label:name,release:null,images:[],video:null,
      created_by:"test",facebook_enabled:facebook,tiktok_enabled:true,
      bluesky:null,scheduled_at:new Date(Date.now()+3600_000).toISOString()});
    await db.prepare("INSERT INTO tiktok_inbox_transfers " +
      "(post_id,status,publish_id,media_ref,created_at,updated_at,sent_by) VALUES (?,?,?,?,?,?,?)")
      .bind(p.id,status,null,"[]",new Date().toISOString(),new Date().toISOString(),"test").run();
    return p;
  };
  const inbox=await make("Old TikTok inbox",false,"processing");
  const mixed=await make("Mixed Facebook TikTok",true,"processing");
  const rejected=await make("Rejected TikTok transfer",false,"rejected");
  assert.ok((await reconcileOldTikTokInboxDrafts(db))>=1);
  const after=(await getPost(db,inbox.id))!;
  assert.equal(after.status,"scheduled");
  assert.ok(after.approved_at);
  assert.equal(after.scheduled_at,null);
  assert.equal((await getPost(db,mixed.id))!.status,"draft");
  assert.equal((await getPost(db,rejected.id))!.status,"draft");
  const html=await (await get("/history?q=Old%20TikTok%20inbox")).text();
  assert.match(html,/TikTok Inbox/);
  assert.match(html,/TikTok transfer, finish in app/);
  assert.equal(await reconcileOldTikTokInboxDrafts(db),0,"reconciliation is idempotent");
});

test("TikTok-only status promotion is version-fenced and needs an existing durable claim",async()=>{
  const p=await createPost(db,{message:"PIN release pending",label:"Version check",release:null,
    images:[],video:null,created_by:"test",facebook_enabled:false,tiktok_enabled:true,
    bluesky:null,scheduled_at:null});
  assert.equal(await markTikTokInboxApproved(db,p.id,p.updated_at),false);
  assert.equal((await getPost(db,p.id))!.status,"draft");
  await db.prepare("INSERT INTO tiktok_inbox_transfers " +
    "(post_id,status,publish_id,media_ref,created_at,updated_at,sent_by) VALUES (?,?,?,?,?,?,?)")
    .bind(p.id,"needs_review",null,"[]",new Date().toISOString(),new Date().toISOString(),"test").run();
  assert.equal(await markTikTokInboxApproved(db,p.id,"2020-01-01T00:00:00.000Z"),false);
  assert.equal(await markTikTokInboxApproved(db,p.id,p.updated_at),true);
  assert.equal((await getPost(db,p.id))!.status,"scheduled");
  assert.equal(await markTikTokInboxApproved(db,p.id,p.updated_at),false,"no duplicate promotion");
});
