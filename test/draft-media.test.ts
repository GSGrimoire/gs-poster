import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { attachDraftImage, createPost, getPost, claimForPublish } from "../src/db.ts";
import { draftMediaPanel } from "../src/draft-media.ts";

let worker:Miniflare;
let db:D1Database;
before(async()=>{
  worker = new Miniflare(convertV4MiniflareOptions({modules:true, cf:false,
    script:"export default {fetch(){return new Response('test')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await worker.getD1Database("DB") as unknown as D1Database;
});
after(async()=>{await worker?.dispose();});
async function draft(){
  return createPost(db,{message:"Test draft",images:[],created_by:"test",
    scheduled_at:null,facebook_enabled:true,
    bluesky:{caption:"Test caption",images:[],patreon:null}});
}
const ref = "upload://"+"b".repeat(32)+".jpg";

test("adding media to both targets is atomic, order-preserving and draft-only",async()=>{
  const p=await draft();
  const next=await attachDraftImage(db,p.id,ref,"A pale undead knight with a burning sword",true,true,p.updated_at);
  assert.ok(next);
  const saved=(await getPost(db,p.id))!;
  assert.deepEqual(saved.images,[ref]);
  assert.deepEqual(saved.bluesky?.images,[{url:ref,alt:"A pale undead knight with a burning sword"}]);
  assert.equal(saved.approved_at,null);
  assert.equal(saved.status,"draft");
  assert.equal(await attachDraftImage(db,p.id,ref,"stale",true,true,p.updated_at),null);
  const second = await attachDraftImage(db,p.id,ref,"Another",true,true,saved.updated_at);
  assert.ok(second);
  const after=(await getPost(db,p.id))!;
  assert.deepEqual(after.images,[ref,ref]);
  assert.equal(after.bluesky?.images[1].alt,"Another");
});

test("cannot attach to an already approved or publishing post",async()=>{
  const p=await draft();
  const won=await claimForPublish(db,p.id,{message:p.message,facebookEnabled:true,
    bluesky:{caption:p.bluesky!.caption,images:[],patreon:null},
    scheduledAt:null,expectedUpdatedAt:p.updated_at});
  assert.equal(won,true);
  const latest=(await getPost(db,p.id))!;
  assert.equal(await attachDraftImage(db,p.id,ref,"No",true,true,latest.updated_at),null);
});

test("Bluesky image cap is 4 and failed append does not add Facebook image",async()=>{
  const p=await draft();
  let current=p.updated_at;
  for(let i=0;i<4;i++){
    const next=await attachDraftImage(db,p.id,ref,"image "+i,true,true,current);
    assert.ok(next);
    current=next!;
  }
  assert.equal(await attachDraftImage(db,p.id,ref,"fifth",true,true,current),null);
  const final=(await getPost(db,p.id))!;
  assert.equal(final.images.length,4);
  assert.equal(final.bluesky?.images.length,4);
});

test("Bluesky-only image and no-alt failure retain consistent draft state",async()=>{
  const p=await draft();
  await assert.rejects(attachDraftImage(db,p.id,ref,"",false,true,p.updated_at),/Alternative text/);
  const next=await attachDraftImage(db,p.id,ref,"A round token framed in rusted iron",false,true,p.updated_at);
  assert.ok(next);
  const after=(await getPost(db,p.id))!;
  assert.equal(after.images.length,0);
  assert.equal(after.bluesky?.images.length,1);
});

test("upload panel only appears before approval and escapes draft attributes",async()=>{
  const p=await draft();
  const markup=draftMediaPanel(p,"test<&csrf");
  assert.match(markup,/draft-media-panel/);
  assert.match(markup,/test&#60;&#38;csrf/);
  assert.match(markup,/draft-media\.js/);
  const approved=await claimForPublish(db,p.id,{message:p.message,facebookEnabled:true,
    bluesky:{caption:p.bluesky!.caption,images:[],patreon:null},
    scheduledAt:null,expectedUpdatedAt:p.updated_at});
  assert.equal(approved,true);
  assert.equal(draftMediaPanel((await getPost(db,p.id))!,"test"),"");
});
