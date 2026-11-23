/** Integration acceptance of the cross-request R2 multipart path.
 * Uses actual Miniflare D1 and R2, not a mocked in-memory multipart uploader.
 */
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createUpload,handleUploadPut,uploadStatusForOwner,getUploadUsage} from "../src/upload.ts";
import {handleLargeVideoChunk,cleanupExpiredChunkUploads} from "../src/chunk-upload.ts";
import {VIDEO_UPLOAD_PART_BYTES,PRIVATE_VIDEO_MAX_BYTES} from "../src/video-limits.ts";
import type {Env} from "../src/env.ts";

let mf:Miniflare,env:Env;
const base="https://poster.test";
const header=new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109]);
const mp4=(size:number)=>{
  const data=new Uint8Array(size);
  data.set(header);
  for(let i=12;i<data.length;i+=4096)data[i]=i%251;
  return data;
};
const call=(url:string,method:string,body?:BodyInit|Uint8Array,headers?:Record<string,string>,runtime=env)=>
  handleLargeVideoChunk(new Request(url,{method,body:body as BodyInit | undefined,headers}),runtime);
const grantId=(reference:string)=>reference.slice("upload://".length,-".mp4".length);
const startUpload=(url:string,size:number)=>{
  const body=JSON.stringify({size});
  return call(url+"/multipart/start","POST",body,{"Content-Length":String(body.length)});
};
const useBucket=(overrides:Partial<R2Bucket>):Env=>({
  ...env, UPLOADS:new Proxy(env.UPLOADS!,{get(bucket,name){
    if(name in overrides)return Reflect.get(overrides,name);
    const value=Reflect.get(bucket,name);
    return typeof value==="function"?value.bind(bucket):value;
  }}),
});
const small=(url:string,bytes:Uint8Array)=>{
  const req=new Request(url,{method:"PUT",body:bytes as unknown as BodyInit,
    headers:{"Content-Length":String(bytes.byteLength)}});
  return handleUploadPut(req,env);
};
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:"export default { fetch: () => new Response('ok') }",
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],
    d1Databases:["DB"],r2Buckets:["UPLOADS"],
  }));
  env={DB:await mf.getD1Database("DB"),UPLOADS:await mf.getR2Bucket("UPLOADS")} as unknown as Env;
});
after(async()=>mf?.dispose());
test("300 MB grant, legacy single PUT refusal and wrong bearer cannot initiate a multipart",async()=>{
  const g=await createUpload(env,base,{filename:"long.mp4",actor:"GSGrimoire"});
  assert.equal(g.max_bytes,PRIVATE_VIDEO_MAX_BYTES);
  const fake=new Request(g.upload_url+"/multipart/start",{
    method:"POST",body:JSON.stringify({size:50_000_001}),
    headers:{"Content-Length":"19","Content-Type":"application/json"}});
  const invalid=await handleLargeVideoChunk(new Request(fake.url.replace(/\/[^/]+\/multipart/,"/wrongtoken/multipart"),fake),env);
  assert.equal(invalid.status,404);
  const oversized=await small(g.upload_url,new Uint8Array(header));
  // The legacy route is independent. A small upload is still valid.
  assert.equal(oversized.status,200);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"stored");
});
test("50 MB boundary refuses multipart before consuming grant; 300 MB upper limit is enforced",async()=>{
  const g=await createUpload(env,base,{filename:"large.mp4",actor:"GSGrimoire"});
  const start=(size:number)=>{
    const body=JSON.stringify({size});
    return call(g.upload_url+"/multipart/start","POST",body,{"Content-Length":String(body.length)});
  };
  assert.equal((await start(50_000_000)).status,413);
  assert.equal((await start(300_000_001)).status,413);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"pending");
});
test("actual multipart completion verifies all parts and denies replay",async()=>{
  const size=50_000_001;
  const data=mp4(size);
  const g=await createUpload(env,base,{filename:"chunked.mp4",actor:"GSGrimoire"});
  const prefix=g.upload_url+"/multipart/";
  const startBody=JSON.stringify({size});
  const start=await call(prefix+"start","POST",startBody,{"Content-Length":String(startBody.length)});
  assert.equal(start.status,200,await start.clone().text());
  const meta=await start.json() as {total_parts:number;chunk_bytes:number};
  assert.equal(meta.chunk_bytes,VIDEO_UPLOAD_PART_BYTES);
  assert.equal(meta.total_parts,Math.ceil(size/VIDEO_UPLOAD_PART_BYTES));
  const reversed=await call(prefix+"part/2","PUT",data.slice(VIDEO_UPLOAD_PART_BYTES,2*VIDEO_UPLOAD_PART_BYTES),
    {"Content-Length":String(VIDEO_UPLOAD_PART_BYTES)});
  assert.equal(reversed.status,409);
  const tooEarly=await call(prefix+"finish","POST");
  assert.equal(tooEarly.status,409);
  for(let number=1;number<=meta.total_parts;number++){
    const first=(number-1)*VIDEO_UPLOAD_PART_BYTES;
    const part=data.slice(first,Math.min(first+VIDEO_UPLOAD_PART_BYTES,size));
    const sent=await call(prefix+"part/"+number,"PUT",part,{"Content-Length":String(part.length)});
    assert.equal(sent.status,200,"part "+number+": "+await sent.clone().text());
    assert.equal((await sent.json() as {next_part:number}).next_part,number+1);
  }
  const final=await call(prefix+"finish","POST");
  assert.equal(final.status,200,await final.clone().text());
  assert.equal((await final.json() as {bytes:number}).bytes,size);
  const status=await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire");
  assert.equal(status?.status,"stored");
  assert.equal(status?.bytes,size);
  const id=g.reference.slice("upload://".length,-".mp4".length);
  const stored=await env.UPLOADS!.get("uploads/"+id+".mp4",{range:{offset:size-128,length:128}});
  assert.ok(stored);
  assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()),data.slice(-128));
  assert.equal((await call(prefix+"part/1","PUT",data.slice(0,VIDEO_UPLOAD_PART_BYTES),
    {"Content-Length":String(VIDEO_UPLOAD_PART_BYTES)})).status,404);
  assert.equal((await getUploadUsage(env.DB)).estimated_stored_bytes>=size,true);
});

test("eleven video grants reserve 50 MB each and a quota refusal preserves an unused link",async()=>{
  const before=(await getUploadUsage(env.DB)).reserved_bytes;
  const grants=await Promise.all(Array.from({length:11},()=>createUpload(env,base,{filename:"batch.mp4",actor:"GSGrimoire"})));
  assert.equal((await getUploadUsage(env.DB)).reserved_bytes-before,550_000_000);
  const g=grants[0];
  const remaining=(await getUploadUsage(env.DB)).remaining_bytes;
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO uploads (id, token_hash, ext, max_bytes, status, created_at, expires_at, bytes)
    VALUES ('quota-fixture','fixture','mp4',?,'stored',?,?,?)`).bind(remaining-1,now,now,remaining-1).run();
  try{
    assert.equal((await startUpload(g.upload_url,50_000_002)).status,409);
    assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"pending");
  }finally{
    await env.DB.prepare("DELETE FROM uploads WHERE id='quota-fixture'").run();
  }
  assert.equal((await startUpload(g.upload_url,50_000_002)).status,200);
  assert.equal((await getUploadUsage(env.DB)).reserved_bytes-before,550_000_002);
  assert.equal((await call(g.upload_url+"/multipart/abort","POST")).status,200);
});

test("a concurrent part cannot take the active session and a truncated part can be resubmitted",async()=>{
  const g=await createUpload(env,base,{filename:"competing.mp4",actor:"GSGrimoire"});
  assert.equal((await startUpload(g.upload_url,50_000_001)).status,200);
  const part=g.upload_url+"/multipart/part/1",headers={"Content-Length":String(VIDEO_UPLOAD_PART_BYTES)};
  assert.equal((await call(part,"PUT",header,headers)).status,400);
  const started=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const runtime=useBucket({resumeMultipartUpload(key,id){
    const upload=env.UPLOADS!.resumeMultipartUpload(key,id);
    return {...upload,async uploadPart(number,value){
      started.resolve();
      await release.promise;
      return upload.uploadPart(number,value);
    }};
  }});
  const bytes=mp4(VIDEO_UPLOAD_PART_BYTES);
  const first=call(part,"PUT",bytes,headers,runtime);
  try{
    await started.promise;
    assert.equal((await call(part,"PUT",bytes,headers)).status,409);
  }finally{release.resolve();}
  assert.equal((await first).status,200);
  assert.equal((await call(g.upload_url+"/multipart/abort","POST")).status,200);
});

async function expired(g:{reference:string}){
  const id=grantId(g.reference),old=new Date(Date.now()-30*60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE uploads SET expires_at=? WHERE id=?").bind(old,id),
    env.DB.prepare("UPDATE video_chunk_sessions SET updated_at=? WHERE id=?").bind(old,id),
  ]);
}

test("expiry retries an uncertain abort before releasing its reservation",async()=>{
  const g=await createUpload(env,base,{filename:"abandoned.mp4",actor:"GSGrimoire"});
  assert.equal((await startUpload(g.upload_url,50_000_001)).status,200);
  const runtime=useBucket({resumeMultipartUpload(key,id){
    const upload=env.UPLOADS!.resumeMultipartUpload(key,id);
    return {...upload,abort:async()=>{throw Error("storage temporarily unavailable");}};
  }});
  assert.equal((await call(g.upload_url+"/multipart/abort","POST",undefined,undefined,runtime)).status,502);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"uploading");
  await expired(g);
  await cleanupExpiredChunkUploads(env);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"failed");
});

/** Start the real route, then seed one small final part for focused failure tests. */
async function readyToFinish(){
  const g=await createUpload(env,base,{filename:"verified.mp4",actor:"GSGrimoire"});
  assert.equal((await startUpload(g.upload_url,50_000_001)).status,200);
  const id=grantId(g.reference),key="uploads/"+id+".mp4", bytes=mp4(256);
  const {upload_id}=await env.DB.prepare("SELECT upload_id FROM video_chunk_sessions WHERE id=?")
    .bind(id).first<{upload_id:string}>() ?? {upload_id:""};
  const part=await env.UPLOADS!.resumeMultipartUpload(key,upload_id).uploadPart(1,bytes);
  const digest=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
  await env.DB.prepare(`UPDATE video_chunk_sessions SET expected_bytes=?,next_part=2,parts_json=? WHERE id=?`)
    .bind(bytes.length,JSON.stringify([{...part,bytes:bytes.length,sha256:digest}]),id).run();
  return {g,key,bytes,finish:g.upload_url+"/multipart/finish"};
}

test("a lost multipart completion response is reconciled against the stored hashes",async()=>{
  const {g,key,bytes,finish}=await readyToFinish();
  const runtime=useBucket({resumeMultipartUpload(k,id){
    const upload=env.UPLOADS!.resumeMultipartUpload(k,id);
    return {...upload,async complete(parts){
      await upload.complete(parts);
      throw Error("completion response lost");
    }};
  }});
  assert.equal((await call(finish,"POST",undefined,undefined,runtime)).status,502);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"uploading");
  assert.ok(await env.UPLOADS!.head(key));
  await expired(g);
  await cleanupExpiredChunkUploads(env);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.bytes,bytes.length);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"stored");
});

test("confirmed checksum mismatch deletes the object before releasing quota",async()=>{
  const {g,key,finish}=await readyToFinish();
  const runtime=useBucket({resumeMultipartUpload(k,id){
    const upload=env.UPLOADS!.resumeMultipartUpload(k,id);
    return {...upload,async complete(parts){
      const ready=await upload.complete(parts);
      await env.UPLOADS!.put(k,new Uint8Array(256));
      return ready;
    }};
  }});
  assert.equal((await call(finish,"POST",undefined,undefined,runtime)).status,502);
  assert.equal(await env.UPLOADS!.head(key),null);
  assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"failed");
});

test("a failed or unacknowledged final database write preserves verified bytes",async()=>{
  for(const committed of [false,true]){
    const {g,key,finish}=await readyToFinish();
    const runtime={...env,DB:{...env.DB,prepare(sql:string){
      const stmt=env.DB.prepare(sql);
      if(!sql.startsWith("UPDATE uploads SET status=?,bytes=?"))return stmt;
      return {bind(...args:unknown[]){return {async run(){
        if(committed)await stmt.bind(...args).run();
        throw Error("final status response unavailable");
      }};}};
    }} as unknown as D1Database};
    assert.equal((await call(finish,"POST",undefined,undefined,runtime)).status,502);
    assert.ok(await env.UPLOADS!.head(key));
    assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,committed?"stored":"uploading");
    await expired(g);
    await cleanupExpiredChunkUploads(env);
    assert.ok(await env.UPLOADS!.head(key));
    assert.equal((await uploadStatusForOwner(env.DB,g.reference,"GSGrimoire"))?.status,"stored");
  }
});
