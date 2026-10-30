import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {fetchStagedBlob,getStagingRepo,importStagedGitHubBlob} from "../src/github-staging.ts";
import {fetchImage} from "../src/media.ts";
import type {Env} from "../src/env.ts";

const SHA="a".repeat(40);
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
const digest=createHash("sha256").update(png).digest("hex");
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
  return {rows,prepare:(sql:string)=>stmt(sql),batch:async (items:any[])=>Promise.all(items.map(x=>x.run()))};
}
function setup(){
  const db=fakeDb(),objects=new Map<string,ArrayBuffer>();
  const env={
    GITHUB_STAGING_REPO:"GSGrimoire/gs-media-staging",
    GITHUB_READ_TOKEN:"test-token",
    UPLOADS:{
      async put(key:string,bytes:ArrayBuffer){objects.set(key,bytes);},
      async get(key:string){const value=objects.get(key);return value?{arrayBuffer:async()=>value}:null;},
    },
    DB:db,
  } as unknown as Env;
  return {db,objects,env};
}
function githubResponse(body:Uint8Array=png,headers:Record<string,string>={}){
  return new Response(body,{status:200,headers:{"Content-Length":String(body.length),...headers}});
}
const github=(response:Response)=>(async(url:string|URL|Request,options?:RequestInit)=>{
  assert.equal(String(url),"https://api.github.com/repos/GSGrimoire/gs-media-staging/git/blobs/"+SHA);
  assert.equal(new Headers(options?.headers).get("Authorization"),"Bearer test-token");
  assert.equal(new Headers(options?.headers).get("Accept"),"application/vnd.github.raw+json");
  assert.equal(options?.redirect,"error");
  return response;
}) as typeof fetch;

test("GitHub staging demands a configured private repository and read token",()=>{
  const {env}=setup();
  assert.deepEqual(getStagingRepo(env),{owner:"GSGrimoire",repo:"gs-media-staging"});
  assert.throws(()=>getStagingRepo({...env,GITHUB_STAGING_REPO:"https://github.com/public/repo"}),/not configured/);
  assert.throws(()=>getStagingRepo({...env,GITHUB_STAGING_REPO:"../../escape"}),/not configured/);
  assert.throws(()=>getStagingRepo({...env,GITHUB_READ_TOKEN:undefined}),/GITHUB_READ_TOKEN/);
  assert.throws(()=>getStagingRepo({...env,UPLOADS:undefined}),/upload storage/);
});

test("downloads original binary bytes, checks signature and SHA-256",async()=>{
  const {env}=setup();
  const received=await fetchStagedBlob(env,{filename:"original.png",blob_sha:SHA,expected_sha256:digest},github(githubResponse()));
  assert.deepEqual(received.bytes,png);
  assert.equal(received.sha256,digest);
  await assert.rejects(fetchStagedBlob(env,{filename:"original.png",blob_sha:SHA,expected_sha256:"f".repeat(64)},github(githubResponse())),/does not match/);
  await assert.rejects(fetchStagedBlob(env,{filename:"original.png",blob_sha:SHA},github(githubResponse(new Uint8Array([1,2,3])))),/media type/);
  await assert.rejects(fetchStagedBlob(env,{filename:"original.exe",blob_sha:SHA},github(githubResponse())),/Only JPG/);
  await assert.rejects(fetchStagedBlob(env,{filename:"original.png",blob_sha:"not-a-sha"},github(githubResponse())),/Invalid GitHub blob/);
  await assert.rejects(fetchStagedBlob(env,{filename:"original.png",blob_sha:SHA},github(githubResponse(png,{"Content-Length":"10485761"}))),/file size/);
});

test("imports a private GitHub blob to an owner-scoped upload without publishing",async()=>{
  const {env,db,objects}=setup();
  const result=await importStagedGitHubBlob(env,"https://poster.test","GSGrimoire",
    {filename:"original.png",blob_sha:SHA,expected_sha256:digest},github(githubResponse()));
  assert.equal(result.status,"stored");
  assert.match(result.reference,/^upload:\/\/[a-f0-9]{32}\.png$/);
  assert.equal(result.bytes,png.length);
  assert.equal(result.sha256,digest);
  assert.equal(db.rows.length,1);
  assert.equal(db.rows[0].created_by,"GSGrimoire");
  assert.equal(db.rows[0].status,"stored");
  assert.equal(objects.size,1);
  assert.equal((await fetchImage(env,result.reference)).bytes.byteLength,png.length);
});

test("invalid GitHub media never writes or reserves private storage",async()=>{
  const {env,db,objects}=setup();
  await assert.rejects(importStagedGitHubBlob(env,"https://poster.test","GSGrimoire",
    {filename:"wrong.png",blob_sha:SHA,expected_sha256:"f".repeat(64)},github(githubResponse())),/does not match/);
  assert.equal(db.rows.length,0);
  assert.equal(objects.size,0);
  await assert.rejects(importStagedGitHubBlob(env,"https://poster.test","",
    {filename:"original.png",blob_sha:SHA},github(githubResponse())),/identity/);
});
