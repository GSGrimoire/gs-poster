import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {fetchChatGPTFile,importChatGPTFile,validateChatGPTFile,type ChatGPTFile} from "../src/chatgpt-native.ts";
import type {Env} from "../src/env.ts";
import {uploadStatusForOwner} from "../src/upload.ts";

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
const digest=createHash("sha256").update(png).digest("hex");
const file:ChatGPTFile={
  file_id:"file-example123",download_url:"https://files.oaiusercontent.com/download/abc?expires=123&signature=secret",
  file_name:"test.png",mime_type:"image/png",
};
const good=(body:Uint8Array=png,headers:Record<string,string>={})=>
  new Response(body,{status:200,headers:{"Content-Length":String(body.byteLength),...headers}});

function fakeDb(){
  const rows:Record<string,any>[]=[];
  const stmt=(sql:string,args:any[]=[]):any=>({
    bind:(...params:any[])=>stmt(sql,params),
    async run(){
      let changes=0;
      if(sql.startsWith("INSERT INTO uploads")){
        const [id,token_hash,ext,max_bytes,created_at,expires_at,created_by]=args;
        rows.push({id,token_hash,ext,max_bytes,created_at,expires_at,created_by,status:"pending",bytes:null});
        changes=1;
      }else if(sql.includes("SET status = 'uploading'")){
        const row=rows.find(x=>x.id===args[0]&&x.status==="pending"&&x.expires_at>args[1]);
        if(row){row.status="uploading";changes=1;}
      }else if(sql.includes("SET status = 'stored'")){
        const row=rows.find(x=>x.id===args[1]&&x.status==="uploading");
        if(row){row.status="stored";row.bytes=args[0];changes=1;}
      }else if(sql.includes("SET status = 'pending'")){
        const row=rows.find(x=>x.id===args[0]&&x.status==="uploading");
        if(row){row.status="pending";changes=1;}
      }
      return {meta:{changes}};
    },
    async first(){return rows.find(x=>x.id===args[0])??null;},
    async all(){return {results:rows.filter(x=>x.created_at>args[0])};},
  });
  return {rows,prepare:(sql:string)=>stmt(sql),batch:async(items:any[])=>Promise.all(items.map(x=>x.run()))};
}
function setup(){
  const db=fakeDb(),objects=new Map<string,ArrayBuffer>();
  const env={DB:db,UPLOADS:{
    async put(key:string,body:ArrayBuffer){objects.set(key,body);},
    async get(key:string){const value=objects.get(key);return value?{arrayBuffer:async()=>value}:null;},
  }} as unknown as Env;
  return {env,db,objects};
}

test("native attachment URL validation prohibits arbitrary network destinations",()=>{
  assert.equal(validateChatGPTFile(file).filename,"test.png");
  for(const url of [
    "http://files.oaiusercontent.com/a",
    "https://files.oaiusercontent.com.evil.test/a",
    "https://127.0.0.1/a",
    "https://files.oaiusercontent.com@127.0.0.1/a",
    "https://files.oaiusercontent.com:8443/a",
    "https://files.oaiusercontent.com/a#fragment",
  ])assert.throws(()=>validateChatGPTFile({...file,download_url:url}),/Unsupported ChatGPT file download origin/);
  assert.throws(()=>validateChatGPTFile({...file,file_id:"made-up"}),/authorized file identifier/);
  assert.throws(()=>validateChatGPTFile({...file,file_name:"test.exe"}),/Only JPG/);
  assert.throws(()=>validateChatGPTFile({...file,mime_type:"video/mp4"}),/disagrees/);
  assert.equal(validateChatGPTFile({...file,file_name:undefined}).filename,"attachment.png");
});

test("native download reads and hashes original binary bytes without model base64",async()=>{
  const download=(async(url:string|URL|Request,init?:RequestInit)=>{
    assert.equal(String(url),file.download_url);
    assert.equal(init?.redirect,"manual");
    assert.equal(init?.credentials,"omit");
    return good();
  }) as typeof fetch;
  const got=await fetchChatGPTFile(file,download);
  assert.deepEqual(got.bytes,png);
  assert.equal(got.sha256,digest);
});

test("native download rejects redirects, missing content and size/header mismatches",async()=>{
  await assert.rejects(fetchChatGPTFile(file,(async()=>new Response(null,{status:302,headers:{Location:"https://example.com"}})) as typeof fetch),/redirected/);
  await assert.rejects(fetchChatGPTFile(file,(async()=>good(png,{"Content-Length":"99999999"})) as typeof fetch),/allowed media size/);
  await assert.rejects(fetchChatGPTFile(file,(async()=>good(new Uint8Array([1,2,3]))) as typeof fetch),/signature/);
  await assert.rejects(fetchChatGPTFile(file,(async()=>new Response(null,{status:403})) as typeof fetch),/unavailable/);
  await assert.rejects(fetchChatGPTFile(file,(async()=>{throw new Error("sensitive provider response");}) as typeof fetch),/secure browser upload/);
});

test("native import stores original bytes privately as owner-scoped draft media",async()=>{
  const {env,db,objects}=setup();
  const got=await importChatGPTFile(env,"https://poster.test","GSGrimoire",file,(async()=>good()) as typeof fetch);
  assert.equal(got.status,"stored");
  assert.equal(got.bytes,png.byteLength);
  assert.equal(got.sha256,digest);
  assert.match(got.reference,/^upload:\/\/[a-f0-9]{32}\.png$/);
  assert.equal(db.rows[0].created_by,"GSGrimoire");
  assert.equal(db.rows[0].status,"stored");
  assert.equal(objects.size,1);
  assert.equal((await uploadStatusForOwner(env.DB,got.reference,"GSGrimoire"))?.status,"stored");
  assert.equal(await uploadStatusForOwner(env.DB,got.reference,"another-editor"),null);
});

test("invalid or redirected file references do not reserve or write private media",async()=>{
  const {env,db,objects}=setup();
  await assert.rejects(importChatGPTFile(env,"https://poster.test","GSGrimoire",
    {...file,download_url:"https://example.com/secret.png"},(async()=>good()) as typeof fetch),/origin/);
  await assert.rejects(importChatGPTFile(env,"https://poster.test","GSGrimoire",
    file,(async()=>new Response(null,{status:301})) as typeof fetch),/redirected/);
  await assert.rejects(importChatGPTFile(env,"https://poster.test","",
    file,(async()=>good()) as typeof fetch),/identity/);
  assert.equal(db.rows.length,0);
  assert.equal(objects.size,0);
});
