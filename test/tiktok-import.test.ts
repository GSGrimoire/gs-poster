// TikTok linked-image import runs through the real signed-in Worker and D1/R2.
// No real GitHub or TikTok requests are permitted: the outbound service mocks
// only a single approved GitHub raw image URL.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost,replaceTikTokDraftImage} from "../src/db.ts";
import {importTikTokLinkedImage,TikTokImportError} from "../src/tiktok-import.ts";
import {uploadStatusForOwner,parseUploadRef,readUpload} from "../src/upload.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="tiktok-image-import-test-cookie-secret";
const PIN="791357"; // Test-only value.
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const GITHUB="https://raw.githubusercontent.com/GSGrimoire/GSImageLibrary/main/cards/cover.png";
const OTHER="https://raw.githubusercontent.com/GSGrimoire/GSImageLibrary/main/cards/second.png";
const PNG=Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=","base64"));
let mf:Miniflare, db:D1Database, r2:R2Bucket;
let fetched:string[]=[];
let corrupt=false,oversize=false;
before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:out.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["UPLOADS"],
    outboundService:async(req:Request)=>{
      fetched.push(req.url);
      if (![GITHUB,OTHER].includes(req.url)) return new Response("blocked",{status:599});
      if (oversize) return new Response(new Uint8Array([9,9]),{status:200,
        headers:{"Content-Length":String(11*1024*1024)}});
      return new Response(corrupt?new Uint8Array([0,1,2,3,4]):PNG,{status:200,
        headers:{"Content-Type":"image/png"}});
    },
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:PIN,TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  r2=await mf.getR2Bucket("UPLOADS") as unknown as R2Bucket;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});
async function draft(images=[GITHUB]){
  return createPost(db,{message:"Goblins",label:"Internal title",images:[...images],video:null,
    tiktok_images:[...images],tiktok_video:null,tiktok_title:"Public title",
    facebook_enabled:true,tiktok_enabled:true,scheduled_at:null,created_by:"test",bluesky:null});
}
async function send(id:string,payload:Record<string,unknown>,o:{
  signedIn?:boolean;origin?:string;csrf?:string
}={}){
  const headers:Record<string,string>={"Content-Type":"application/json",
    Origin:o.origin??ORIGIN,"Sec-Fetch-Site":o.origin&&o.origin!==ORIGIN?"cross-site":"same-origin"};
  let csrf=o.csrf;
  if(o.signedIn!==false){
    const raw=await makeSession(signer,"GSGrimoire");
    headers.Cookie=SESSION_COOKIE+"="+raw;
    csrf??=await csrfToken(signer,{login:"GSGrimoire",raw} as Session);
  }
  return mf.dispatchFetch(ORIGIN+"/post/"+id+"/import-tiktok-image",{
    method:"POST",headers,body:JSON.stringify({csrf:csrf??"",...payload}),redirect:"manual"});
}
function reset(){fetched=[];corrupt=false;oversize=false;}

test("import prepares TikTok only, with source order and owner-bound verified R2 bytes",async()=>{
  reset();
  const p=await draft([GITHUB,OTHER]);
  let response=await send(p.id,{index:0,expected_updated_at:p.updated_at});
  assert.equal(response.status,200,await response.clone().text());
  let result=await response.json() as {ok:boolean;reference:string;updated_at:string};
  assert.equal(result.ok,true);
  let saved=(await getPost(db,p.id))!;
  assert.equal(saved.updated_at,result.updated_at);
  assert.deepEqual(saved.images,[GITHUB,OTHER],"Facebook gallery is never mutated");
  assert.equal(saved.tiktok_images![1],OTHER,"second TikTok image stays at its position");
  assert.match(saved.tiktok_images![0],/^upload:\/\/[a-f0-9]{32}\.png$/);
  assert.equal(await uploadStatusForOwner(db,result.reference,"GSGrimoire")?.then(x=>x?.status),"stored");
  const bytes=await readUpload({UPLOADS:r2} as Env,parseUploadRef(result.reference)!);
  assert.deepEqual(new Uint8Array(bytes),PNG);
  assert.equal(saved.approved_at,null);
  assert.equal(saved.status,"draft");
  assert.deepEqual(fetched,[GITHUB],"only one saved GitHub URL was requested");

  response=await send(p.id,{index:1,expected_updated_at:result.updated_at});
  assert.equal(response.status,200,await response.clone().text());
  result=await response.json() as typeof result;
  saved=(await getPost(db,p.id))!;
  assert.deepEqual(saved.images,[GITHUB,OTHER]);
  assert.match(saved.tiktok_images![1],/^upload:\/\/[a-f0-9]{32}\.png$/);
  assert.deepEqual(fetched,[GITHUB,OTHER]);
});

test("import rejects forged index, stale version, arbitrary URLs, unselected TikTok and approved post",async()=>{
  reset();
  const p=await draft();
  assert.equal((await send(p.id,{index:1,expected_updated_at:p.updated_at})).status,404);
  assert.equal((await send(p.id,{index:-1,expected_updated_at:p.updated_at})).status,400);
  assert.equal((await send(p.id,{index:"0",expected_updated_at:p.updated_at})).status,400);
  assert.equal((await send(p.id,{index:0,expected_updated_at:"2020-01-01T00:00:00Z"})).status,409);
  assert.equal((await send(p.id,{index:0,expected_updated_at:p.updated_at},{signedIn:false})).status,302);
  assert.equal((await send(p.id,{index:0,expected_updated_at:p.updated_at},{origin:"https://evil.example"})).status,403);
  assert.equal((await send(p.id,{index:0,expected_updated_at:p.updated_at},{csrf:"forged"})).status,403);
  assert.equal(fetched.length,0,"unauthorized or stale calls cannot fetch remote files");

  const wrong=await createPost(db,{message:"Other",label:"test",images:["https://evil.example/file.png"],
    tiktok_images:["https://evil.example/file.png"],tiktok_enabled:true,facebook_enabled:true,
    scheduled_at:null,created_by:"test",bluesky:null});
  assert.equal((await send(wrong.id,{index:0,expected_updated_at:wrong.updated_at})).status,400);
  assert.equal(fetched.length,0,"an arbitrary URL attached by an old draft is never fetched");

  await db.prepare("UPDATE posts SET tiktok_enabled=0 WHERE id=?").bind(p.id).run();
  assert.equal((await send(p.id,{index:0,expected_updated_at:p.updated_at})).status,409);
  await db.prepare("UPDATE posts SET tiktok_enabled=1,approved_at=? WHERE id=?")
    .bind(new Date().toISOString(),p.id).run();
  assert.equal((await send(p.id,{index:0,expected_updated_at:p.updated_at})).status,409);
  assert.equal(fetched.length,0);
});

test("invalid image header or oversized GitHub response never attaches or publishes",async()=>{
  reset();corrupt=true;
  const p=await draft();
  const invalid=await send(p.id,{index:0,expected_updated_at:p.updated_at});
  assert.equal(invalid.status,400);
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,[GITHUB]);
  assert.equal((await getPost(db,p.id))!.approved_at,null);
  corrupt=false;oversize=true;
  const large=await send(p.id,{index:0,expected_updated_at:p.updated_at});
  assert.notEqual(large.status,200);
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,[GITHUB]);
});

test("a concurrent edit makes the original import request stale without changing the draft",async()=>{
  reset();
  const p=await draft();
  await db.prepare("UPDATE posts SET updated_at=? WHERE id=?")
    .bind(new Date(Date.now()+60000).toISOString(),p.id).run();
  const r=await send(p.id,{index:0,expected_updated_at:p.updated_at});
  assert.equal(r.status,409);
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,[GITHUB]);
  assert.equal(fetched.length,0);
});

test("forged URL fields cannot influence GitHub source selection",async()=>{
  reset();
  const p=await draft();
  const res=await send(p.id,{index:0,expected_updated_at:p.updated_at,
    source_url:"https://evil.example/secret.png",url:"https://evil.example/other.png"});
  assert.equal(res.status,200,await res.clone().text());
  assert.deepEqual(fetched,[GITHUB]);
});

test("database replacement fences on original source even when the draft version matches",async()=>{
  reset();
  const p=await draft();
  const fake="upload://"+"b".repeat(32)+".png";
  const no=await replaceTikTokDraftImage(db,p.id,0,OTHER,fake,p.updated_at);
  assert.equal(no,null);
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,[GITHUB]);
});

test("corrupted R2 readback is never marked ready or attached",async()=>{
  reset();
  const p=await draft();
  const previous=globalThis.fetch;
  const proxy=new Proxy(r2,{get(target,key){
    if(key==="get")return async (...args:unknown[])=>{
      const object=await (target.get as (...args:unknown[])=>Promise<unknown>).apply(target,args);
      return object ? {arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer} : null;
    };
    const v=(target as unknown as Record<PropertyKey,unknown>)[key];
    return typeof v==="function"?(v as Function).bind(target):v;
  }});
  globalThis.fetch=async()=>new Response(PNG,{status:200});
  try {
    await assert.rejects(importTikTokLinkedImage({DB:db,UPLOADS:proxy} as Env,
      p.id,0,p.updated_at,"GSGrimoire",ORIGIN),/private image copy was not confirmed/i);
    assert.deepEqual((await getPost(db,p.id))!.tiktok_images,[GITHUB]);
    const status=await db.prepare("SELECT status FROM uploads WHERE created_by='GSGrimoire' ORDER BY created_at DESC LIMIT 1")
      .first<{status:string}>();
    assert.equal(status?.status,"uploading","incomplete integrity checks cannot become ready");
  } finally { globalThis.fetch=previous; }
});

test("concurrent draft changes during external fetch prevent private attachment",async()=>{
  reset();
  const p=await draft();
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>{
    await db.prepare("UPDATE posts SET updated_at=? WHERE id=?")
      .bind(new Date(Date.now()+60000).toISOString(),p.id).run();
    return new Response(PNG,{status:200});
  };
  try {
    await assert.rejects(importTikTokLinkedImage({DB:db,UPLOADS:r2} as Env,
      p.id,0,p.updated_at,"GSGrimoire",ORIGIN),/draft changed while importing/i);
    const saved=(await getPost(db,p.id))!;
    assert.deepEqual(saved.images,[GITHUB]);
    assert.deepEqual(saved.tiktok_images,[GITHUB]);
    assert.equal(saved.approved_at,null);
  } finally { globalThis.fetch=previous; }
});

test("a completed private upload cannot be re-imported and does not duplicate TikTok media",async()=>{
  reset();
  const p=await draft();
  const res=await send(p.id,{index:0,expected_updated_at:p.updated_at});
  assert.equal(res.status,200,await res.clone().text());
  const completed=(await getPost(db,p.id))!;
  const second=await send(p.id,{index:0,expected_updated_at:completed.updated_at});
  assert.equal(second.status,400);
  assert.deepEqual((await getPost(db,p.id))!.tiktok_images,completed.tiktok_images);
  assert.equal(fetched.length,1);
});
