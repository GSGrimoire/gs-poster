import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {attachDraftVideo,claimForPublish,createPost,getPost,reopenCancelledDraft,setBlueskyStatus,updatePost} from "../src/db.ts";
import {restoreCancelledPost} from "../src/publish.ts";
import {draftMediaPanel} from "../src/draft-media.ts";
import type {Env} from "../src/env.ts";

let worker:Miniflare;
let db:D1Database;
const oldVideo="upload://"+"a".repeat(32)+".mp4";
const newVideo="upload://"+"b".repeat(32)+".mp4";
const env={FB_PAGE_ID:"page",FB_PAGE_TOKEN:"fake-token",GRAPH_BASE_URL:"http://127.0.0.1:8999"} as Env;

before(async()=>{
  worker=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:"export default {fetch(){return new Response('test')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await worker.getD1Database("DB") as unknown as D1Database;
  env.DB=db;
});
after(async()=>{await worker?.dispose();});

async function cancelled(video=true) {
  const p=await createPost(db,{
    message:"House Rule Compendium",images:[],video:video?oldVideo:null,
    created_by:"ChatGPT",scheduled_at:"2030-11-01T12:00:00Z",
    facebook_enabled:true,
    bluesky:{caption:"Rules",images:[],video:video?{url:oldVideo,alt:"House rules"}:null,patreon:null},
  });
  assert.equal(await claimForPublish(db,p.id,{
    message:p.message,scheduledAt:new Date("2030-11-01T12:00:00Z"),
    facebookEnabled:true,bluesky:p.bluesky,expectedUpdatedAt:p.updated_at,
  }),true);
  await updatePost(db,p.id,{status:"scheduled",fb_post_id:"video_123"},["publishing"]);
  await setBlueskyStatus(db,p.id,{status:"scheduled"},["draft"]);
  await setBlueskyStatus(db,p.id,{status:"cancelled"},["scheduled"]);
  await updatePost(db,p.id,{status:"cancelled"},["scheduled"]);
  return (await getPost(db,p.id))!;
}

test("cancelled video safely reopens to a draft only when deleted on Facebook",async()=>{
  const p=await cancelled();
  const originalFetch=globalThis.fetch;
  let reads=0,writes=0;
  globalThis.fetch=async (_input,init)=>{
    if(init?.method && init.method!=="GET") writes++;
    reads++;
    return Response.json({error:{code:100,message:"Unsupported get request: object was deleted"}},{status:404});
  };
  try {
    assert.equal(await restoreCancelledPost(env,p.id,p.updated_at,"reviewer"),true);
    assert.equal(reads,1);
    assert.equal(writes,0,"reopening never calls Facebook POST or DELETE");
    const restored=(await getPost(db,p.id))!;
    assert.equal(restored.status,"draft");
    assert.equal(restored.approved_at,null);
    assert.equal(restored.scheduled_at,null,"old schedule cannot be silently restored");
    assert.equal(restored.fb_post_id,null);
    assert.equal(restored.permalink,null);
    assert.equal(restored.bluesky?.status,"draft");
    assert.equal(restored.bluesky?.uri,null);
    assert.equal(restored.bluesky?.cid,null);
    assert.equal(restored.video,oldVideo,"keeps existing media until successful replacement");
    assert.equal(restored.bluesky?.video?.url,oldVideo);
    assert.equal(restored.message,p.message);
    assert.equal(await restoreCancelledPost(env,p.id,p.updated_at,"reviewer"),false);
    const panel=draftMediaPanel(restored,"csrf");
    assert.match(panel,/\+ Replace video/);
    assert.match(panel,/video-facebook" checked/);
    assert.match(panel,/video-bluesky" checked/);
  }finally {globalThis.fetch=originalFetch;}
});

test("reopening refuses Facebook object that still exists, leaving approval intact",async()=>{
  const p=await cancelled();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({published:false,scheduled_publish_time:1980000000,description:"Still scheduled"});
  try {
    await assert.rejects(restoreCancelledPost(env,p.id,p.updated_at,"reviewer"),/still exists/);
    const saved=(await getPost(db,p.id))!;
    assert.equal(saved.status,"cancelled");
    assert.ok(saved.approved_at);
    assert.equal(saved.fb_post_id,"video_123");
  }finally{globalThis.fetch=originalFetch;}
});

test("reopening fails closed on Facebook authorization or network errors",async()=>{
  const p=await cancelled();
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({error:{code:190,message:"Invalid token"}},{status:401});
  try{
    await assert.rejects(restoreCancelledPost(env,p.id,p.updated_at,"reviewer"),/Invalid token/);
    assert.equal((await getPost(db,p.id))?.status,"cancelled");
  }finally{globalThis.fetch=old;}
});

test("published or publishing Bluesky target blocks reopening even if main status is cancelled",async()=>{
  const p=await cancelled();
  await setBlueskyStatus(db,p.id,{status:"publishing"},["cancelled"]);
  const latest=(await getPost(db,p.id))!;
  await assert.rejects(restoreCancelledPost(env,p.id,latest.updated_at,"reviewer"),/Bluesky has already started/);
  assert.equal(await reopenCancelledDraft(db,p.id,latest.updated_at),false);
  await setBlueskyStatus(db,p.id,{status:"published",uri:"at://example/post"},["publishing"]);
  const latest2=(await getPost(db,p.id))!;
  assert.equal(await reopenCancelledDraft(db,p.id,latest2.updated_at),false);
});

test("stale version cannot reopen a cancelled post",async()=>{
  const p=await cancelled();
  assert.equal(await reopenCancelledDraft(db,p.id,"stale-version"),false);
  assert.equal((await getPost(db,p.id))?.status,"cancelled");
});

test("replacement updates both pending video targets together and does not change approval",async()=>{
  const p=await cancelled();
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({error:{code:100,message:"Unsupported get request"}},{status:404});
  try{assert.equal(await restoreCancelledPost(env,p.id,p.updated_at,"reviewer"),true);}
  finally{globalThis.fetch=old;}
  const draft=(await getPost(db,p.id))!;
  const next=await attachDraftVideo(db,p.id,newVideo,"A rule video with music",true,true,draft.updated_at);
  assert.ok(next);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.video,newVideo);
  assert.equal(saved.bluesky?.video?.url,newVideo);
  assert.equal(saved.bluesky?.video?.alt,"A rule video with music");
  assert.equal(saved.status,"draft");
  assert.equal(saved.approved_at,null);
  assert.equal(saved.fb_post_id,null);
  assert.equal(saved.scheduled_at,null);
  assert.equal(await attachDraftVideo(db,p.id,oldVideo,"Stale",true,true,draft.updated_at),null);
});

test("replacing one platform preserves the other platform's video until selected",async()=>{
  const p=await createPost(db,{message:"Test",images:[],video:oldVideo,
    created_by:"test",scheduled_at:null,facebook_enabled:true,
    bluesky:{caption:"Test",images:[],video:{url:oldVideo,alt:"Original"},patreon:null}});
  const next=await attachDraftVideo(db,p.id,newVideo,"New audio",false,true,p.updated_at);
  assert.ok(next);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.video,oldVideo);
  assert.equal(saved.bluesky?.video?.url,newVideo);
});
