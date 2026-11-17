/** Integration acceptance of the cross-request R2 multipart path.
 * Uses actual Miniflare D1 and R2, not a mocked in-memory multipart uploader.
 */
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createUpload,handleUploadPut,uploadStatusForOwner,getUploadUsage} from "../src/upload.ts";
import {handleLargeVideoChunk} from "../src/chunk-upload.ts";
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
const call=(url:string,method:string,body?:BodyInit|Uint8Array,headers?:Record<string,string>)=>
  handleLargeVideoChunk(new Request(url,{method,body:body as BodyInit | undefined,headers}),env);
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
