import { test } from "node:test";
import assert from "node:assert/strict";
import { checkImageUrl, fetchImage } from "../src/media.ts";
import { createUpload, handleUploadPut, looksLike, parseUploadRef,
  UPLOAD_MAX_LINKS_PER_HOUR, UPLOAD_QUOTA_BYTES } from "../src/upload.ts";
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
