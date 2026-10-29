import {test} from "node:test";
import assert from "node:assert/strict";
import {createChatUploadBatch,checkChatUploadBatch,validateChatFilenames,
  CHAT_BATCH_MAX_FILES} from "../src/chat-media.ts";
import {handleUploadPut,UPLOAD_QUOTA_BYTES} from "../src/upload.ts";
import {blankNewDraft,parseNewDraft,renderNewDraft} from "../src/new-draft.ts";
import type {Env} from "../src/env.ts";

type Row=Record<string,any>;
function setup() {
 const rows:Row[]=[];
 const stmt=(sql:string,args:any[]=[])=>({
  bind:(...a:any[])=>stmt(sql,a),
  async run(){
   let changes=0;
   if(sql.startsWith("INSERT INTO uploads")){
    const [id,token_hash,ext,max_bytes,created_at,expires_at,created_by]=args;
    rows.push({id,token_hash,ext,max_bytes,status:"pending",created_at,expires_at,created_by,bytes:null});
    changes++;
   }else if(sql.includes("SET status = 'uploading'")){
    const row=rows.find(r=>r.id===args[0]&&r.status==="pending"&&r.expires_at>args[1]);
    if(row){row.status="uploading";changes++;}
   }else if(sql.includes("SET status = 'stored'")){
    const row=rows.find(r=>r.id===args[1]&&r.status==="uploading");
    if(row){row.status="stored";row.bytes=args[0];changes++;}
   }else if(sql.includes("SET status = 'pending'")){
    const row=rows.find(r=>r.id===args[0]&&r.status==="uploading");
    if(row){row.status="pending";changes++;}
   }
   return {meta:{changes}};
  },
  async first(){return rows.find(x=>x.id===args[0])??null;},
  async all(){return {results:rows.filter(x=>x.created_at>args[0]).map(x=>({...x}))};},
 });
 const db={prepare:(sql:string)=>stmt(sql),batch:async(stmts:any[])=>Promise.all(stmts.map(s=>s.run()))};
 const objects=new Map<string,ArrayBuffer>();
 const bucket={put:async(key:string,data:ArrayBuffer)=>{objects.set(key,data)}};
 return {env:{DB:db,UPLOADS:bucket} as unknown as Env,rows,objects};
}

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13]);
test("carousel batch keeps exact image order and returns independent private handoffs",async()=>{
 const {env}=setup();
 const filenames=["cover.png","spread.jpg","detail.gif"];
 const batch=await createChatUploadBatch(env,"https://poster.test","editor",filenames);
 assert.equal(batch.created,3);
 assert.equal(batch.stopped_reason,null);
 assert.deepEqual(batch.uploads.map(x=>x.filename),filenames);
 assert.deepEqual(batch.uploads.map(x=>x.index),[1,2,3]);
 assert.equal(new Set(batch.uploads.map(x=>x.reference)).size,3);
 assert.ok(batch.uploads.every(x=>x.upload_page_url===x.upload_url));
 assert.ok(batch.uploads.every(x=>x.upload_page_url.startsWith("https://poster.test/upload/")));
 const check=await checkChatUploadBatch(env.DB,"editor",batch.uploads.map(x=>x.reference));
 assert.equal(check.all_ready,false);
 assert.equal(check.ready_count,0);
 assert.equal(check.tiktok_limit,35);
 assert.equal(check.bluesky_image_limit,4);
 assert.equal(check.facebook_image_limit,80);
});
test("batch status requires ownership and actual PUT confirmation",async()=>{
 const {env}=setup();
 const batch=await createChatUploadBatch(env,"https://poster.test","editor",["cover.png","other.png"]);
 const [first,second]=batch.uploads;
 const response=await handleUploadPut(new Request(first.upload_url,{
  method:"PUT",body:png as unknown as BodyInit,headers:{"Content-Length":String(png.length)}
 }),env);
 assert.equal(response.status,200);
 const check=await checkChatUploadBatch(env.DB,"editor",[first.reference,second.reference]);
 assert.equal(check.ready_count,1);
 assert.deepEqual(check.results.map(x=>x.ready),[true,false]);
 const other=await checkChatUploadBatch(env.DB,"different",[first.reference]);
 assert.equal(other.results[0].status,"unavailable");
 assert.equal(other.all_ready,false);
});
test("batch upload validates extension and file count without creating public media",async()=>{
 assert.throws(()=>validateChatFilenames([]),/between 1/);
 assert.throws(()=>validateChatFilenames(Array(CHAT_BATCH_MAX_FILES+1).fill("image.png")),/between 1/);
 assert.throws(()=>validateChatFilenames(["../script.exe"]),/filename/);
 assert.deepEqual(validateChatFilenames([" still.png "]),["still.png"]);
 const {env}=setup();
 const batch=await createChatUploadBatch(env,"https://poster.test","editor",["one.png","two.mp4"]);
 assert.equal(batch.uploads[1].max_bytes,20_000_000);
 assert.ok(batch.uploads.every(x=>!x.upload_page_url.includes("/publish/")));
});
test("TikTok-specific caption and hashtags are preserved without modifying Facebook text",()=>{
 const fields={...blankNewDraft(),facebook:true,bluesky:false,tiktok:true,
  contentKind:"images" as const,message:"Facebook announcement",tiktokCaption:"Fantasy carousel #ttrpg #dnd"};
 const post=parseNewDraft(fields,"Europe/Copenhagen","Editor");
 assert.equal(post.message,"Facebook announcement");
 assert.equal(post.tiktok_caption,"Fantasy carousel #ttrpg #dnd");
 const html=renderNewDraft(fields,"testcsrf","Europe/Copenhagen");
 assert.match(html,/id="new-tiktok-caption"/);
 assert.match(html,/Fantasy carousel #ttrpg #dnd/);
 const fallback=parseNewDraft({...fields,tiktokCaption:""},"Europe/Copenhagen","Editor");
 assert.equal(fallback.tiktok_caption,null);
 assert.throws(()=>parseNewDraft({...fields,tiktokCaption:"x".repeat(4001)},"Europe/Copenhagen","Editor"),/TikTok caption/);
});
