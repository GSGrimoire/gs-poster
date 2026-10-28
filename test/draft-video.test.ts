import { before,after,test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare,convertV4MiniflareOptions } from "miniflare";
import { createPost,getPost,attachDraftVideo,attachDraftImage,claimForPublish } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { renderCalendar } from "../src/calendar.ts";
import { draftMediaPanel } from "../src/draft-media.ts";

let worker:Miniflare;
let db:D1Database;
const videoRef="upload://"+"a".repeat(32)+".mp4";
const imageRef="upload://"+"b".repeat(32)+".png";
before(async()=>{
  worker = new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:"export default {fetch(){return new Response('test')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await worker.getD1Database("DB") as unknown as D1Database;
});
after(async()=>await worker?.dispose());
async function draft(){
  return createPost(db,{message:"Video post",images:[],video:null,
    scheduled_at:"2030-11-28T18:00:00Z",facebook_enabled:true,created_by:"ChatGPT",
    bluesky:{caption:"Video for Bluesky",images:[],video:null,patreon:null}});
}

test("one private MP4 can be saved for Facebook and Bluesky before approval",async()=>{
  const p=await draft();
  const next=await attachDraftVideo(db,p.id,videoRef,"Portrait video of fantasy game rules",true,true,p.updated_at);
  assert.ok(next);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.video,videoRef);
  assert.deepEqual(saved.bluesky?.video,{url:videoRef,alt:"Portrait video of fantasy game rules"});
  assert.equal(saved.approved_at,null);
  assert.equal(saved.status,"draft");
  assert.match(draftMediaPanel(saved,"csrf"),/video-preview/);
  assert.match(renderCalendar({TIMEZONE:"Europe/Copenhagen"} as Env,[saved],"csrf","2030-11-24"),/Video post/);
  assert.ok(await attachDraftVideo(db,p.id,videoRef,"Again",true,true,saved.updated_at),
    "An unapproved draft may replace its video.");
  assert.equal(await attachDraftVideo(db,p.id,videoRef,"Stale",true,true,p.updated_at),null);
});

test("Facebook video and photo media are mutually exclusive",async()=>{
  const p=await draft();
  const newVersion=await attachDraftImage(db,p.id,imageRef,"Fantasy game poster",true,false,p.updated_at);
  assert.ok(newVersion);
  assert.equal(await attachDraftVideo(db,p.id,videoRef,"Video",true,false,newVersion!),null);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.video,null);
  assert.deepEqual(saved.images,[imageRef]);
});

test("Bluesky video excludes images while leaving Facebook images optional",async()=>{
  const p=await draft();
  const v=await attachDraftVideo(db,p.id,videoRef,"Video description",false,true,p.updated_at);
  assert.ok(v);
  assert.equal(await attachDraftImage(db,p.id,imageRef,"Photo",false,true,v!),null);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.video,null);
  assert.equal(saved.bluesky?.images.length,0);
  assert.equal(saved.bluesky?.video?.url,videoRef);
});

test("approval locks video attachments regardless of ownership",async()=>{
  const p=await draft();
  assert.equal(await claimForPublish(db,p.id,{message:p.message,facebookEnabled:true,
    bluesky:{caption:p.bluesky!.caption,images:[],video:null,patreon:null},
    scheduledAt:new Date(p.scheduled_at!),expectedUpdatedAt:p.updated_at}),true);
  const saved=(await getPost(db,p.id))!;
  assert.equal(await attachDraftVideo(db,p.id,videoRef,"No",true,true,saved.updated_at),null);
});

test("Bluesky video attachment enforces descriptive accessibility text",async()=>{
  const p=await draft();
  await assert.rejects(attachDraftVideo(db,p.id,videoRef,"",false,true,p.updated_at),/alternative text/);
});
