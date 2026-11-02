// Claude can prepare the Instagram carousel through update_draft: the same
// fenced save as the editor, own photos only, house caption rules, and never
// any sending. Real D1 in workerd; the production handler.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {handleUpdateDraft} from "../src/mcp.ts";
import type {Env} from "../src/env.ts";

let mf:Miniflare,db:D1Database;
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:"export default {fetch(){return new Response('')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

const IMG=(n:number)=>"https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/"+n+".png";
const MSG="Winter cave map. Free in the Archive: patreon.com/GSGrimoire";
const env=()=>({DB:db,ALLOWED_GITHUB_LOGINS:"Alice",TIMEZONE:"Europe/Copenhagen"}) as unknown as Env;
const body=(r:any)=>JSON.parse(r.content[0].text);
const item=(url:string,o:Partial<{mode:"crop"|"pad";cx:number;cy:number;zoom:number;bg:any}>={})=>
  ({url,mode:"crop" as const,cx:0.5,cy:0.5,zoom:1,bg:"dark" as const,...o});
async function draft(){
  return createPost(db,{message:MSG,label:"Cave",release:"Maps",images:[IMG(1),IMG(2)],video:null,created_by:"test",
    scheduled_at:null,facebook_enabled:true,tiktok_enabled:false,bluesky:null} as any);
}
const ig=(items:any[],extra:any={})=>({caption:"Winter cave, four phases. #dnd #battlemap",frame:"4:5" as const,items,...extra});

test("update_draft sets the Instagram carousel and reads it back exactly",async()=>{
  const p=await draft();
  const want=ig([item(IMG(2),{mode:"pad",bg:"parchment"}),item(IMG(1),{cx:0.2,zoom:1.5})]);
  const r=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:p.updated_at,instagram:want} as any);
  assert.equal(r.isError,undefined,JSON.stringify(body(r)));
  assert.deepEqual((await getPost(db,p.id))!.instagram,want);
  assert.deepEqual(body(r).post.instagram.items,want.items);
  assert.match(body(r).post.instagram.note,/Prepared only/);
  // Other edits leave it alone; null removes it.
  const r2=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:body(r).updated_at,message:MSG+" Edited."} as any);
  assert.deepEqual((await getPost(db,p.id))!.instagram,want);
  const r3=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:body(r2).updated_at,instagram:null} as any);
  assert.equal(r3.isError,undefined);
  assert.equal((await getPost(db,p.id))!.instagram,null);
});

test("only this post's photos, house caption rules, and Instagram limits",async()=>{
  const p=await draft();
  const cases:[any,RegExp][]=[
    [ig([item("https://evil.example/x.png")]),/not one of this post's photos/],
    [ig([item(IMG(1)),item(IMG(1))]),/twice/],
    [ig([item(IMG(1))],{caption:"Only 5 kr. in the Archive"}),/Instagram caption:/],
    [ig([item(IMG(1))],{caption:Array.from({length:31},(_,i)=>"#t"+i).join(" ")}),/30 hashtags/],
  ];
  for(const [input,re] of cases){
    const r=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:p.updated_at,instagram:input} as any);
    assert.equal(r.isError,true);
    assert.match(JSON.stringify(body(r)),re);
  }
  assert.equal((await getPost(db,p.id))!.instagram,null,"nothing was saved");
  assert.equal((await getPost(db,p.id))!.updated_at,p.updated_at);
});

test("a photo added in the same update may be used",async()=>{
  const p=await draft();
  const r=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:p.updated_at,
    images:[IMG(1),IMG(2),IMG(3)],instagram:ig([item(IMG(3))])} as any);
  // IMG(3) is a GitHub image; preflight may refuse it offline, but never with the own-photo error.
  assert.doesNotMatch(JSON.stringify(body(r)),/not one of this post's photos/);
});

test("Instagram alone counts as a platform; stale versions save nothing",async()=>{
  const p=await draft();
  const r=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:p.updated_at,
    facebook_enabled:false,instagram:ig([item(IMG(1))])} as any);
  assert.equal(r.isError,undefined,JSON.stringify(body(r)));
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.facebook_enabled,false);
  assert.equal(saved.instagram!.items.length,1);
  const stale=await handleUpdateDraft(env(),"https://x","Alice",{id:p.id,expected_updated_at:p.updated_at,instagram:null} as any);
  assert.equal(stale.isError,true);
  assert.equal((await getPost(db,p.id))!.instagram!.items.length,1);
});
