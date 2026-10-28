import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, claimForPublish, getPost, updatePost, setBlueskyStatus, updateCalendarTime } from "../src/db.ts";
import { reschedulePost, editPendingCaptions } from "../src/publish.ts";
import type { Env } from "../src/env.ts";

let worker: Miniflare;
let db: D1Database;
const env = { FB_PAGE_ID:"page", FB_PAGE_TOKEN:"test-token",
  GRAPH_BASE_URL:"http://127.0.0.1:8999", TIMEZONE:"Europe/Copenhagen" } as Env;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:"export default {fetch(){return new Response('test')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await worker.getD1Database("DB") as unknown as D1Database;
  env.DB=db;
});
after(async()=>{await worker?.dispose();});

async function scheduled(combined=true) {
  const at=new Date(Date.now()+4*60*60_000);
  const p=await createPost(db,{message:"Facebook caption",images:[],
    scheduled_at:at.toISOString(),created_by:"test",facebook_enabled:true,
    bluesky:combined ? {caption:"Bluesky caption",images:[],patreon:null} : null});
  assert.equal(await claimForPublish(db,p.id,{message:p.message,
    facebookEnabled:true,bluesky:combined?{caption:"Bluesky caption",images:[],patreon:null}:null,
    scheduledAt:at,expectedUpdatedAt:p.updated_at}),true);
  if(combined) await setBlueskyStatus(db,p.id,{status:"scheduled"},["draft"]);
  await updatePost(db,p.id,{status:"scheduled",fb_post_id:"page_post"},["publishing"]);
  return (await getPost(db,p.id))!;
}
async function audits(id:string, action:string) {
  const r=await db.prepare("SELECT action FROM audit WHERE post_id=? AND action=?")
    .bind(id,action).all<{action:string}>();
  return r.results.length;
}

test("uncertain Facebook schedule read-back is audited, local record unchanged",async()=>{
  const p=await scheduled();
  const original=globalThis.fetch;
  const old=Math.floor(Date.parse(p.scheduled_at!)/1000);
  let real=old, writes=0;
  globalThis.fetch=async (_url,init)=>{
    if(init?.method==="POST"){
      writes++; real=Number((init.body as URLSearchParams).get("scheduled_publish_time"));
      return Response.json({success:true});
    }
    return Response.json({is_published:false,scheduled_publish_time:old,message:p.message});
  };
  try{
    await assert.rejects(reschedulePost(env,p.id,new Date((old+3600)*1000),p.updated_at,"test"),/Check Meta Business Suite/);
    assert.equal(writes,1);
    assert.equal(real,old+3600);
    assert.equal((await getPost(db,p.id))?.scheduled_at,p.scheduled_at);
    assert.equal(await audits(p.id,"reschedule-reconciliation-required"),1);
  }finally{globalThis.fetch=original;}
});

test("uncertain Facebook caption read-back is audited, local caption unchanged",async()=>{
  const p=await scheduled();
  const original=globalThis.fetch;
  const old=Math.floor(Date.parse(p.scheduled_at!)/1000);
  let real=p.message, writes=0;
  globalThis.fetch=async (_url,init)=>{
    if(init?.method==="POST"){
      writes++;real=String((init.body as URLSearchParams).get("message"));
      return Response.json({success:true});
    }
    return Response.json({is_published:false,scheduled_publish_time:old,message:p.message});
  };
  try{
    await assert.rejects(editPendingCaptions(env,p.id,p.updated_at,"changed","new sky","test"),/Check Meta Business Suite/);
    assert.equal(writes,1);
    assert.equal(real,"changed");
    assert.equal((await getPost(db,p.id))?.message,p.message);
    assert.equal(await audits(p.id,"caption-reconciliation-required"),1);
  }finally{globalThis.fetch=original;}
});

test("database schedule failure triggers Facebook rollback to original schedule",async()=>{
  const p=await scheduled(false);
  const old=Math.floor(Date.parse(p.scheduled_at!)/1000);
  let current=old, writes=0;
  const original=globalThis.fetch;
  globalThis.fetch=async (_url,init)=>{
    if(init?.method==="POST"){
      writes++;current=Number((init.body as URLSearchParams).get("scheduled_publish_time"));
      return Response.json({success:true});
    }
    return Response.json({is_published:false,scheduled_publish_time:current,message:p.message});
  };
  await db.prepare("CREATE TRIGGER calendar_fail BEFORE UPDATE OF scheduled_at ON posts BEGIN SELECT RAISE(ABORT,'blocked test write'); END").run();
  try{
    await assert.rejects(reschedulePost(env,p.id,new Date((old+3600)*1000),p.updated_at,"test"),/Facebook was restored/);
    assert.equal(current,old);
    assert.equal(writes,2);
    assert.equal((await getPost(db,p.id))?.scheduled_at,p.scheduled_at);
  }finally{
    await db.prepare("DROP TRIGGER calendar_fail").run();
    globalThis.fetch=original;
  }
});

test("database caption failure triggers Facebook rollback",async()=>{
  const p=await scheduled(false);
  const old=Math.floor(Date.parse(p.scheduled_at!)/1000);
  let message=p.message, writes=0;
  const original=globalThis.fetch;
  globalThis.fetch=async (_url,init)=>{
    if(init?.method==="POST"){
      writes++;message=String((init.body as URLSearchParams).get("message"));
      return Response.json({success:true});
    }
    return Response.json({is_published:false,scheduled_publish_time:old,message});
  };
  await db.prepare("CREATE TRIGGER caption_fail BEFORE UPDATE OF message ON posts BEGIN SELECT RAISE(ABORT,'blocked test write'); END").run();
  try{
    await assert.rejects(editPendingCaptions(env,p.id,p.updated_at,"new Facebook",null,"test"),/Facebook was restored/);
    assert.equal(message,p.message);
    assert.equal(writes,2);
    assert.equal((await getPost(db,p.id))?.message,p.message);
  }finally{
    await db.prepare("DROP TRIGGER caption_fail").run();
    globalThis.fetch=original;
  }
});

test("already published posts cannot be rescheduled or have captions edited",async()=>{
  const p=await scheduled(false);
  await updatePost(db,p.id,{status:"published"},["scheduled"]);
  const live=(await getPost(db,p.id))!;
  const original=globalThis.fetch;
  let writes=0;
  globalThis.fetch=async (_url,init)=>{if(init?.method==="POST")writes++;return Response.json({});};
  try{
    await assert.rejects(reschedulePost(env,p.id,new Date(Date.now()+5*60*60_000),live.updated_at,"test"),/immutable/);
    await assert.rejects(editPendingCaptions(env,p.id,live.updated_at,"changed",null,"test"),/Only pending/);
    assert.equal(writes,0);
  }finally{globalThis.fetch=original;}
});

test("Bluesky cron claim blocks schedule update even if post version is unchanged",async()=>{
  const p=await scheduled();
  await setBlueskyStatus(db,p.id,{status:"publishing"},["scheduled"]);
  const moved=await updateCalendarTime(db,p.id,new Date(Date.now()+6*60*60_000).toISOString(),p.updated_at,true,true);
  assert.equal(moved,false);
  assert.equal((await getPost(db,p.id))?.scheduled_at,p.scheduled_at);
  await assert.rejects(reschedulePost(env,p.id,new Date(Date.now()+5*60*60_000),p.updated_at,"test"),/Bluesky target/);
});
