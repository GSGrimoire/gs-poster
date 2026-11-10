import { test } from "node:test";
import assert from "node:assert/strict";
import { checkImageUrl, fetchImage } from "../src/media.ts";
import { INITIAL_VIDEO_MAX_BYTES } from "../src/video.ts";
import { createUpload, handleUploadPut, looksLike, parseUploadRef,
  UPLOAD_MAX_LINKS_PER_HOUR, UPLOAD_QUOTA_BYTES, pendingUploadPageInfo, uploadStatusForOwner } from "../src/upload.ts";
import {CHAT_UPLOAD_JS,browserUploadPage} from "../src/chat-upload.ts";
import type { Env } from "../src/env.ts";

type Row = Record<string, any>;
function fakeDb() {
  const rows: Row[] = [];
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...values: any[]) => stmt(sql, values),
    async run() {
      let changes = 0;
      if (sql.startsWith("INSERT INTO uploads")) {
        const [id,token_hash,ext,max_bytes,created_at,expires_at,created_by] = args;
        rows.push({id,token_hash,ext,max_bytes,status:"pending",created_at,expires_at,created_by,bytes:null});
        changes++;
      } else if (sql.includes("SET status = 'uploading'")) {
        const r = rows.find(x=>x.id===args[0] && x.status==="pending" && x.expires_at>args[1]);
        if(r){r.status="uploading";changes++;}
      } else if (sql.includes("SET status = 'stored'")) {
        const r = rows.find(x=>x.id===args[1] && x.status==="uploading");
        if(r){r.status="stored";r.bytes=args[0];changes++;}
      } else if (sql.includes("SET status = 'pending'")) {
        const r = rows.find(x=>x.id===args[0] && x.status==="uploading");
        if(r){r.status="pending";changes++;}
      } else if (sql.startsWith("DELETE FROM uploads")) {
        for(let i=rows.length-1;i>=0;i--) if(rows[i].created_at<args[0]){rows.splice(i,1);changes++;}
      }
      return {meta:{changes}};
    },
    async first(){return rows.find(x=>x.id===args[0])??null;},
    async all(){return {results:rows.filter(x=>x.created_at>args[0]).map(x=>({...x}))};},
  });
  return {rows,prepare:(sql:string)=>stmt(sql),
    batch:async(list:any[])=>Promise.all(list.map(s=>s.run()))};
}
function setup() {
  const db = fakeDb();
  const objects = new Map<string,ArrayBuffer>();
  const r2 = {objects,async put(key:string,value:ArrayBuffer){objects.set(key,value);},
    async get(key:string){const v=objects.get(key);return v?{arrayBuffer:async()=>v}:null;}};
  return {db,objects,env:{DB:db,UPLOADS:r2} as unknown as Env};
}
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13]);
const upload = (url:string, bytes:Uint8Array, length=bytes.length) =>
  new Request(url,{method:"PUT",body:bytes as unknown as BodyInit,
    headers:{"Content-Length":String(length)}});

test("upload references and signatures are strict",()=>{
  const id="a".repeat(32);
  assert.deepEqual(parseUploadRef("upload://"+id+".png"),{id,ext:"png"});
  assert.equal(parseUploadRef("upload://"+id.toUpperCase()+".png"),null);
  assert.equal(parseUploadRef("upload://"+id+".exe"),null);
  assert.equal(checkImageUrl("upload://"+id+".png"),null);
  assert.ok(checkImageUrl("upload://"+id+".mp4"));
  assert.ok(checkImageUrl("https://example.com/image.png"));
  assert.equal(looksLike("png",png),true);
  assert.equal(looksLike("gif",png),false);
  assert.equal(looksLike("mp4",new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109])),true);
});
test("one-time PUT, token hashed in database, private Worker read",async()=>{
  const {env,db,objects}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"cover.png",actor:"test"});
  assert.match(grant.reference,/^upload:\/\/[a-f0-9]{32}\.png$/);
  assert.notEqual(db.rows[0].token_hash,grant.upload_url.split("/").pop());
  assert.equal((await handleUploadPut(upload(grant.upload_url,png),env)).status,200);
  assert.equal(db.rows[0].status,"stored");
  assert.equal(objects.size,1);
  assert.equal((await fetchImage(env,grant.reference)).bytes.byteLength,png.length);
  assert.equal((await handleUploadPut(upload(grant.upload_url,png),env)).status,404);
});
test("invalid token, expired link, bad signature and size rejected",async()=>{
  const {env,db,objects}=setup();
  const g=await createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"});
  const wrong=g.upload_url.replace(/[^/]+$/,"x".repeat(32));
  assert.equal((await handleUploadPut(upload(wrong,png),env)).status,404);
  assert.equal((await handleUploadPut(upload(g.upload_url,new Uint8Array([1,2,3])),env)).status,415);
  assert.equal(db.rows[0].status,"pending");
  assert.equal((await handleUploadPut(upload(g.upload_url,png,g.max_bytes+1),env)).status,413);
  assert.equal(objects.size,0);
  db.rows[0].expires_at=new Date(Date.now()-1000).toISOString();
  assert.equal((await handleUploadPut(upload(g.upload_url,png),env)).status,404);
});
test("two simultaneous attempts can store only once",async()=>{
  const {env,objects}=setup();
  const g=await createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"});
  const statuses=(await Promise.all([handleUploadPut(upload(g.upload_url,png),env),
    handleUploadPut(upload(g.upload_url,png),env)])).map(x=>x.status).sort();
  assert.deepEqual(statuses,[200,404]);
  assert.equal(objects.size,1);
});
test("quotas, unsupported files and missing R2 are enforced",async()=>{
  const {env,db}=setup();
  await assert.rejects(createUpload(env,"https://poster.test",{filename:"a.exe",actor:"test"}),/Unsupported/);
  for(let i=0;i<UPLOAD_MAX_LINKS_PER_HOUR;i++)
    await createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"});
  await assert.rejects(createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"}),/Too many/);
  db.rows.length=0;
  db.rows.push({id:"a".repeat(32),status:"stored",max_bytes:10,bytes:UPLOAD_QUOTA_BYTES-5,
    expires_at:"",created_at:new Date().toISOString()});
  await assert.rejects(createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"}),/storage is full/);
  await assert.rejects(createUpload({DB:db} as unknown as Env,"https://poster.test",
    {filename:"a.png",actor:"test"}),/not set up/);
});

test("ambiguous R2 write failure consumes bearer link and blocks a second PUT",async()=>{
  const {env,db}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"a.png",actor:"test"});
  const bucket=env.UPLOADS!;
  let calls=0;
  (bucket as unknown as {put: (...args:unknown[]) => Promise<void>}).put=async()=>{
    calls++;
    throw new Error("R2 did not confirm write");
  };
  assert.equal((await handleUploadPut(upload(grant.upload_url,png),env)).status,500);
  assert.equal(db.rows[0].status,"uploading");
  assert.equal((await handleUploadPut(upload(grant.upload_url,png),env)).status,404);
  assert.equal(calls,1);
});


test("chat upload handoff is one-time, does not expose bearer credentials in page HTML",async()=>{
  const {env}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"token.png",actor:"GSGrimoire"});
  const url=new URL(grant.upload_url);
  const parts=url.pathname.split("/");
  const info=await pendingUploadPageInfo(env.DB,parts[2],parts[3]);
  assert.deepEqual(info,{ext:"png",maxBytes:10*1024*1024});
  const response=await browserUploadPage(new Request(grant.upload_url),env);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Referrer-Policy"),"no-referrer");
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.match(response.headers.get("Content-Security-Policy")||"",/script-src 'self'/);
  const body=await response.text();
  assert.match(body,/Upload privately/);
  assert.match(body,/src="\/upload-client.js"/);
  assert.match(body,/data-ext="png"/);
  assert.doesNotMatch(body,new RegExp(parts[3]));
  assert.doesNotMatch(body,/https:\/\/[^"]+\.js/);
  assert.equal((await browserUploadPage(new Request(grant.upload_url,{method:"POST"}),env)).status,405);
  assert.equal((await handleUploadPut(upload(grant.upload_url,png),env)).status,200);
  assert.equal((await browserUploadPage(new Request(grant.upload_url),env)).status,404);
});

test("upload readiness is scoped to the authenticated uploader, not the MCP client name",async()=>{
  const {env}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"poster.png",actor:"GSGrimoire"});
  assert.equal((await uploadStatusForOwner(env.DB,grant.reference,"gsgrimoire"))?.status,"pending");
  assert.equal(await uploadStatusForOwner(env.DB,grant.reference,"AnotherEditor"),null);
  assert.equal((await uploadStatusForOwner(env.DB,"upload://"+"x".repeat(32)+".png","GSGrimoire")),null);
  assert.equal((await handleUploadPut(upload(grant.upload_url,png),env)).status,200);
  const state=await uploadStatusForOwner(env.DB,grant.reference,"GSGrimoire");
  assert.equal(state?.status,"stored");
  assert.equal(state?.bytes,png.byteLength);
});

test("chat uploader sends file bytes with a one-time PUT and never auto-publishes",()=>{
  assert.match(CHAT_UPLOAD_JS,/method:"PUT",body:selected/);
  assert.match(CHAT_UPLOAD_JS,/referrerPolicy:"no-referrer"/);
  assert.match(CHAT_UPLOAD_JS,/credentials:"omit"/);
  assert.match(CHAT_UPLOAD_JS,/response\.reference/);
  assert.doesNotMatch(CHAT_UPLOAD_JS,/\/approve|\/publish/);
});

test("MP4 grants accept 40 MB files with a 50 MB bound, not unbounded uploads",async()=>{
  const {env}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"clip.mp4",actor:"GSGrimoire"});
  assert.equal(grant.max_bytes,50_000_000);
  assert.equal(INITIAL_VIDEO_MAX_BYTES,50_000_000);
  const url=new URL(grant.upload_url),parts=url.pathname.split("/");
  const info=await pendingUploadPageInfo(env.DB,parts[2],parts[3]);
  assert.equal(info?.maxBytes,50_000_000);
  const headerOnly=new Request(grant.upload_url,{method:"PUT",body:new Uint8Array(12),headers:{
    "Content-Length":"50000001",
  }});
  assert.equal((await handleUploadPut(headerOnly,env)).status,413);
});

test("actual image bytes are bounded even when Content-Length declares fewer bytes",async()=>{
  const {env,db,objects}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"cover.png",actor:"test"});
  const body=new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(png);
      controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  });
  const req=new Request(grant.upload_url,{
    method:"PUT",body,headers:{"Content-Length":String(png.byteLength)},duplex:"half",
  } as RequestInit & {duplex:"half"});
  const res=await handleUploadPut(req,env);
  assert.equal(res.status,413,await res.clone().text());
  assert.equal(objects.size,0,"no object is stored after an actual-size violation");
  assert.equal(db.rows[0].status,"pending","pre-write rejection does not consume the token");
});

test("actual MP4 bytes cannot exceed their grant even if the declared size is accepted",async()=>{
  const {env,db,objects}=setup();
  const grant=await createUpload(env,"https://poster.test",{filename:"sample.mp4",actor:"test"});
  // Use a tiny effective grant so the overrun is caught without materializing
  // or storing a multi-megabyte body. The extension signature is valid.
  db.rows[0].max_bytes=20;
  const mp4=new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,0,0,0,0]);
  const body=new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp4);
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const req=new Request(grant.upload_url,{
    method:"PUT",body,headers:{"Content-Length":"20"},duplex:"half",
  } as RequestInit & {duplex:"half"});
  const res=await handleUploadPut(req,env);
  assert.equal(res.status,413,await res.clone().text());
  assert.equal(objects.size,0,"oversized MP4 cannot be finalized");
  assert.notEqual(db.rows[0].status,"stored");
  assert.equal((await handleUploadPut(upload(grant.upload_url,mp4),env)).status,404,
    "a possibly started multipart write does not reopen the bearer token");
});
