// Issue #63: MCP update_draft must persist the selected platforms and save the
// post and its Bluesky target in ONE version-fenced D1 transaction.
// Runs the real handler against a real D1 (workerd via Miniflare). No publish
// call, no Facebook, no PIN: update_draft cannot approve or publish anything.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {handleUpdateDraft} from "../src/mcp.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
let mf:Miniflare,db:D1Database;

before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:"export default {fetch(){return new Response('')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

const MSG="Four goblins wait in the cave. Free in the Archive: patreon.com/GSGrimoire";
function envWith(DB:D1Database):Env{
  return {DB,ALLOWED_GITHUB_LOGINS:"Alice",TIMEZONE:"Europe/Copenhagen"} as unknown as Env;
}
async function draft(o:{bluesky?:boolean;facebook?:boolean;tiktokNull?:boolean}={}){
  return createPost(db,{message:MSG,label:"Goblins",release:"NPC",images:[],video:null,created_by:"test",
    scheduled_at:null,facebook_enabled:o.facebook??true,tiktok_enabled:!!o.tiktokNull,
    tiktok_images:o.tiktokNull?null:undefined,
    bluesky:o.bluesky?{caption:"Goblins in the cave #GSGrimoire",images:[],video:null,patreon:null}:null} as any);
}
function body(r:any){return JSON.parse(r.content[0].text);}
async function update(input:any,DB:D1Database=db){
  return handleUpdateDraft(envWith(DB),ORIGIN,"Alice",input);
}
async function bsRow(id:string){
  return db.prepare("SELECT facebook_enabled,status FROM bluesky_targets WHERE post_id=?").bind(id)
    .first<{facebook_enabled:number;status:string}>();
}

test("facebook_enabled:false is persisted on the post that approval reads",async()=>{
  const p=await draft({bluesky:true});
  const r=await update({id:p.id,facebook_enabled:false,expected_updated_at:p.updated_at});
  assert.equal(r.isError,undefined,JSON.stringify(body(r)));
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.facebook_enabled,false);
  assert.equal((await bsRow(p.id))?.facebook_enabled,0);
  assert.equal(body(r).post.facebook_enabled,false);
  assert.equal(body(r).updated_at,saved.updated_at);
  // ...and back on again, fenced by the version the last save returned.
  const r2=await update({id:p.id,facebook_enabled:true,expected_updated_at:body(r).updated_at});
  assert.equal(r2.isError,undefined);
  assert.equal((await getPost(db,p.id))!.facebook_enabled,true);
  assert.equal((await bsRow(p.id))?.facebook_enabled,1);
});

test("a stale expected_updated_at saves nothing",async()=>{
  const p=await draft({bluesky:true});
  const first=await update({id:p.id,message:MSG+" First.",expected_updated_at:p.updated_at});
  assert.equal(first.isError,undefined);
  const stale=await update({id:p.id,message:MSG+" Second.",facebook_enabled:false,expected_updated_at:p.updated_at});
  assert.equal(stale.isError,true);
  assert.match(body(stale).error,/changed since you read it/);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.message,MSG+" First.");
  assert.equal(saved.facebook_enabled,true);
});

test("two editors saving the same version: exactly one wins",async()=>{
  const p=await draft({bluesky:true});
  const [a,b]=await Promise.all([
    update({id:p.id,message:MSG+" A.",expected_updated_at:p.updated_at}),
    update({id:p.id,message:MSG+" B.",facebook_enabled:false,expected_updated_at:p.updated_at}),
  ]);
  const wins=[a,b].filter(r=>!r.isError);
  assert.equal(wins.length,1);
  const saved=(await getPost(db,p.id))!;
  if(wins[0]===a){assert.equal(saved.message,MSG+" A.");assert.equal(saved.facebook_enabled,true);}
  else{assert.equal(saved.message,MSG+" B.");assert.equal(saved.facebook_enabled,false);}
});

test("an approved post is never changed, even with a matching version",async()=>{
  const p=await draft({bluesky:true});
  await db.prepare("UPDATE posts SET approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id).run();
  const cur=(await getPost(db,p.id))!;
  const r=await update({id:p.id,facebook_enabled:false,expected_updated_at:cur.updated_at});
  assert.equal(r.isError,true);
  assert.equal((await getPost(db,p.id))!.facebook_enabled,true);
});

test("approval landing between the read and the write: the save is refused",async()=>{
  const p=await draft({bluesky:true});
  // A DB whose first batch() is preceded by an approval, as if the owner
  // approved in the browser while the assistant was saving.
  let raced=false;
  const racing=new Proxy(db,{get(t,k){
    if(k==="batch")return async(stmts:D1PreparedStatement[])=>{
      if(!raced){raced=true;await t.prepare("UPDATE posts SET approved_at=?,updated_at=? WHERE id=?")
        .bind(new Date().toISOString(),new Date(Date.now()+5).toISOString(),p.id).run();}
      return t.batch(stmts);
    };
    const v=(t as any)[k];return typeof v==="function"?v.bind(t):v;
  }}) as D1Database;
  const r=await update({id:p.id,facebook_enabled:false,message:MSG+" Late.",expected_updated_at:p.updated_at},racing);
  assert.equal(r.isError,true);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.facebook_enabled,true);
  assert.equal(saved.message,MSG);
  assert.equal((await bsRow(p.id))?.facebook_enabled,1);
});

test("a failing statement inside the save rolls back the whole transaction",async()=>{
  const p=await draft({bluesky:true});
  const failing=new Proxy(db,{get(t,k){
    if(k==="batch")return async(stmts:D1PreparedStatement[])=>
      t.batch([...stmts,t.prepare("INSERT INTO no_such_table VALUES (1)")]);
    const v=(t as any)[k];return typeof v==="function"?v.bind(t):v;
  }}) as D1Database;
  const r=await update({id:p.id,facebook_enabled:false,message:MSG+" Lost.",expected_updated_at:p.updated_at},failing);
  assert.equal(r.isError,true);
  assert.match(body(r).error,/Not saved/);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.updated_at,p.updated_at);
  assert.equal(saved.facebook_enabled,true);
  assert.equal(saved.message,MSG);
  assert.equal((await bsRow(p.id))?.facebook_enabled,1);
});

test("committed but response lost: reported as uncertain, never as saved or retried",async()=>{
  const p=await draft({bluesky:true});
  const lost=new Proxy(db,{get(t,k){
    if(k==="batch")return async(stmts:D1PreparedStatement[])=>{await t.batch(stmts);throw new Error("network reset");};
    const v=(t as any)[k];return typeof v==="function"?v.bind(t):v;
  }}) as D1Database;
  const r=await update({id:p.id,facebook_enabled:false,expected_updated_at:p.updated_at},lost);
  assert.equal(r.isError,true);
  assert.match(body(r).error,/uncertain/);
});

test("removing Bluesky keeps Facebook; the last platform cannot be switched off",async()=>{
  const p=await draft({bluesky:true});
  const r=await update({id:p.id,bluesky:null,expected_updated_at:p.updated_at});
  assert.equal(r.isError,undefined);
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.bluesky,null);
  assert.equal(saved.facebook_enabled,true);
  const none=await update({id:p.id,facebook_enabled:false,expected_updated_at:saved.updated_at});
  assert.equal(none.isError,true);
  assert.equal((await getPost(db,p.id))!.facebook_enabled,true);
});

test("a TikTok shared-gallery fallback (null) is not collapsed to an empty list",async()=>{
  const p=await draft({tiktokNull:true});
  assert.equal(p.tiktok_images,null);
  const r=await update({id:p.id,message:MSG+" Edited.",expected_updated_at:p.updated_at});
  assert.equal(r.isError,undefined,JSON.stringify(body(r)));
  assert.equal((await getPost(db,p.id))!.tiktok_images,null);
});

test("omitting expected_updated_at still fences on the version read in this call",async()=>{
  const p=await draft();
  const r=await update({id:p.id,message:MSG+" No fence given."});
  assert.equal(r.isError,undefined);
  assert.notEqual(body(r).updated_at,p.updated_at);
});
