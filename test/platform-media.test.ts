import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,getPost,attachDraftImage,attachDraftVideo,tiktokMedia} from "../src/db.ts";
import {renderNewDraft,blankNewDraft,parseNewDraft} from "../src/new-draft.ts";
import {NEW_DRAFT_JS} from "../src/new-draft-client.ts";
import type {Env} from "../src/env.ts";
let worker:Miniflare;
let env:Env;
const ref=(n:number,ext="png")=>"upload://"+n.toString(16).padStart(32,"0")+"."+ext;
before(async()=>{
  worker=new Miniflare(convertV4MiniflareOptions({
    modules:true,cf:false,script:"export default {fetch(){return new Response('ok')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]
  }));
  env={DB:await worker.getD1Database("DB") as unknown as D1Database} as Env;
});
after(async()=>await worker?.dispose());
async function draft(facebook=true,tiktok=true,bluesky=true){
  return createPost(env.DB,{message:"Facebook source caption",tiktok_caption:"TikTok version #fantasy",
    images:[],tiktok_images:tiktok?[]:null,video:null,scheduled_at:null,created_by:"test",
    facebook_enabled:facebook,tiktok_enabled:tiktok,bluesky:bluesky?{
      caption:"Bluesky caption",images:[],video:null,patreon:null
    }:null});
}
test("Facebook 8, TikTok 6, Bluesky 4 use distinct galleries without forced smallest limit",async()=>{
  let p=await draft();
  for(let i=1;i<=8;i++){
    const rev=await attachDraftImage(env.DB,p.id,ref(i),"Image "+i,true,i<=4,p.updated_at,i<=6);
    assert.ok(rev,"image "+i);
    p=(await getPost(env.DB,p.id))!;
  }
  assert.equal(p.images.length,8);
  assert.equal(tiktokMedia(p).images.length,6);
  assert.equal(p.bluesky?.images.length,4);
  assert.equal(p.video,null);
  assert.equal(p.tiktok_video,null);
  assert.deepEqual(tiktokMedia(p).images,p.images.slice(0,6));
  assert.deepEqual(p.bluesky?.images.map(x=>x.url),p.images.slice(0,4));
  assert.equal(p.tiktok_caption,"TikTok version #fantasy");
  assert.equal(p.approved_at,null);
  assert.equal(await attachDraftImage(env.DB,p.id,ref(9),"bad",false,true,p.updated_at,false),null);
  assert.equal((await getPost(env.DB,p.id))!.images.length,8);
});
test("TikTok-only media stays out of Facebook while Facebook has its own photos",async()=>{
  let p=await draft();
  let next=await attachDraftImage(env.DB,p.id,ref(10),"",true,false,p.updated_at,false);
  assert.ok(next);p=(await getPost(env.DB,p.id))!;
  next=await attachDraftImage(env.DB,p.id,ref(11),"",false,false,p.updated_at,true);
  assert.ok(next);p=(await getPost(env.DB,p.id))!;
  assert.deepEqual(p.images,[ref(10)]);
  assert.deepEqual(tiktokMedia(p).images,[ref(11)]);
  assert.equal(p.bluesky?.images.length,0);
  assert.equal(await attachDraftImage(env.DB,p.id,ref(12),"",false,false,"1970-01-01T00:00:00Z",true),null);
});
test("TikTok video may coexist with Facebook image gallery in a saved draft",async()=>{
  let p=await draft();
  assert.ok(await attachDraftImage(env.DB,p.id,ref(20),"",true,false,p.updated_at,false));
  p=(await getPost(env.DB,p.id))!;
  assert.ok(await attachDraftVideo(env.DB,p.id,ref(21,"mp4"),"",false,false,p.updated_at,true));
  p=(await getPost(env.DB,p.id))!;
  assert.equal(p.video,null);
  assert.deepEqual(p.images,[ref(20)]);
  assert.equal(tiktokMedia(p).video,ref(21,"mp4"));
  assert.deepEqual(tiktokMedia(p).images,[]);
  assert.equal(await attachDraftImage(env.DB,p.id,ref(22),"",false,false,p.updated_at,true),null);
});
test("Legacy TikTok records still fall back to the historical shared media",async()=>{
  const p=await createPost(env.DB,{
    message:"Old post",images:[ref(2)],video:null,created_by:"test",
    scheduled_at:null,facebook_enabled:true,tiktok_enabled:true,bluesky:null
  });
  assert.equal(p.tiktok_images,null);
  assert.deepEqual(tiktokMedia(p).images,[ref(2)]);
});
test("New composer renders three accessible caption columns and destination controls",()=>{
  const fields={...blankNewDraft(),facebook:true,bluesky:true,tiktok:true,contentKind:"images" as const};
  const html=renderNewDraft(fields,"csrf","Europe/Copenhagen");
  assert.match(html,/platform-editor-grid/);
  assert.match(html,/aria-label="Platform-specific captions"/);
  for(const id of ["new-facebook-panel","new-tiktok-panel","new-bluesky-panel","new-platform-counts"])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(NEW_DRAFT_JS,/item\.targets\[name\]=check/);
  assert.match(NEW_DRAFT_JS,/item\.order<4/);
  assert.match(NEW_DRAFT_JS,/item\.order<35/);
  assert.match(NEW_DRAFT_JS,/fb&&item\.targets\.facebook\.checked/);
  assert.match(NEW_DRAFT_JS,/bs&&item\.targets\.bluesky\.checked/);
  assert.match(NEW_DRAFT_JS,/target\("tiktok"\)&&item\.targets\.tiktok\.checked/);
  assert.doesNotMatch(html,/action="[^"]*\/approve"/);
  const input=parseNewDraft(fields,"Europe/Copenhagen","test");
  assert.deepEqual(input.tiktok_images,[]);
});
