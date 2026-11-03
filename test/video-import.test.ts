/** Production route tests for linked MP4 private preparation and manual Instagram download. */
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost,saveEditorDraft, type Post, type EditorDraft} from "../src/db.ts";
import {createUpload,handleUploadPut,readUpload,parseUploadRef,uploadStatusForOwner} from "../src/upload.ts";
import {parseEditorForm} from "../src/draft-editor.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";
import type {InstagramDraft} from "../src/instagram.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="reel-video-import-test-secret";
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const FB="https://raw.githubusercontent.com/GSGrimoire/Images/main/videos/facebook.mp4";
const TT="https://raw.githubusercontent.com/GSGrimoire/Images/main/videos/tiktok.mp4";
const BS="https://raw.githubusercontent.com/GSGrimoire/Images/main/videos/bluesky.mp4";
const IG="https://raw.githubusercontent.com/GSGrimoire/Images/main/videos/instagram.mp4";
const MP4=Uint8Array.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,0,0,0,0]);
const BODY=Uint8Array.from(MP4);
let mf:Miniflare, db:D1Database, bucket:R2Bucket;
let requests:string[]=[];
let malicious=false,oversize=false;
before(async()=>{
  const output=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:output.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["UPLOADS"],
    outboundService:async(req:Request)=>{
      requests.push(req.url);
      if(![FB,TT,BS,IG].includes(req.url))return new Response("Blocked",{status:599});
      if(oversize)return new Response(MP4,{status:200,headers:{"Content-Length":String(20_000_001)}});
      return new Response(malicious?new Uint8Array([1,2,3,4]):MP4,{status:200});
    },bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  bucket=await mf.getR2Bucket("UPLOADS") as unknown as R2Bucket;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});
function clear(){requests=[];malicious=false;oversize=false;}
async function auth(){
  const raw=await makeSession(signer,"GSGrimoire");
  const csrf=await csrfToken(signer,{login:"GSGrimoire",raw} as Session);
  return {Cookie:SESSION_COOKIE+"="+raw,csrf};
}
async function request(id:string,route:string,payload:Record<string,unknown>,opts:{
  login?:boolean;origin?:string;csrf?:string
}={}){
  const creds=opts.login===false?null:await auth();
  const origin=opts.origin??ORIGIN;
  return mf.dispatchFetch(ORIGIN+"/post/"+id+"/"+route,{
    method:"POST",redirect:"manual",
    headers:{"Content-Type":"application/json",Origin:origin,"Sec-Fetch-Site":origin===ORIGIN?"same-origin":"cross-site",
      ...(creds?{Cookie:creds.Cookie}:{})},
    body:JSON.stringify({csrf:opts.csrf??creds?.csrf??"",...payload}),
  });
}
async function getDownload(id:string,logged=true){
  const creds=logged?await auth():null;
  return mf.dispatchFetch(ORIGIN+"/instagram/"+id+"/video.mp4",{
    method:"GET",redirect:"manual",headers:creds?{Cookie:creds.Cookie}:{},
  });
}
async function makeDraft() {
  return createPost(db,{message:"Creature release",images:[],video:FB,
    tiktok_images:[],tiktok_video:TT,tiktok_enabled:true,facebook_enabled:true,
    scheduled_at:null,created_by:"test",bluesky:{
      caption:"Other text",images:[],video:{url:BS,alt:"A creature moves"},
      patreon:null}});
}
function next(p:Post):EditorDraft {
  return {message:p.message,tiktok_caption:p.tiktok_caption,tiktok_title:p.tiktok_title,
    images:p.images,tiktok_images:p.tiktok_images,video:p.video,tiktok_video:p.tiktok_video,
    facebook_enabled:p.facebook_enabled,tiktok_enabled:!!p.tiktok_enabled,
    bluesky_enabled:!!p.bluesky,instagram_enabled:true,scheduled_at:p.scheduled_at,
    label:p.label,release:p.release};
}
const ig=(video:string):InstagramDraft=>({caption:"Manual #Reel",frame:"4:5",items:[],video});

test("preparing TikTok, Bluesky and Instagram videos preserves independent source media and approval",async()=>{
  clear();
  const initial=await makeDraft();
  const version=(await saveEditorDraft(db,initial.id,initial.updated_at,next(initial),initial.bluesky,ig(IG)))!;
  assert.ok(version);
  const original=(await getPost(db,initial.id))!;
  let current=original.updated_at;
  const refs:Record<string,string>={};
  for(const target of ["tiktok","bluesky","instagram"]){
    const response=await request(initial.id,"import-video",{target,expected_updated_at:current,
      url:"https://evil.example/file.mp4",source_url:"https://evil.example/other.mp4"});
    assert.equal(response.status,200,await response.clone().text());
    const result=await response.json() as {reference:string;updated_at:string;ok:boolean};
    assert.equal(result.ok,true);
    assert.match(result.reference,/^upload:\/\/[a-f0-9]{32}\.mp4$/);
    assert.equal((await uploadStatusForOwner(db,result.reference,"gsgrimoire"))?.status,"stored");
    assert.deepEqual(new Uint8Array(await readUpload({UPLOADS:bucket} as Env,parseUploadRef(result.reference)!)),BODY);
    refs[target]=result.reference;
    current=result.updated_at;
  }
  const saved=(await getPost(db,initial.id))!;
  assert.equal(saved.tiktok_video,refs.tiktok);
  assert.equal(saved.bluesky?.video?.url,refs.bluesky);
  assert.equal(saved.instagram?.video,refs.instagram);
  assert.equal(saved.video,FB);
  assert.deepEqual(saved.images,[]);
  assert.equal(saved.bluesky?.video?.alt,"A creature moves");
  assert.equal(saved.approved_at,null);
  assert.equal(saved.status,"draft");
  assert.deepEqual(requests,[TT,BS,IG],"fetch only the source already on each saved target");
  const download=await getDownload(initial.id);
  assert.equal(download.status,200);
  assert.equal(download.headers.get("Content-Type"),"video/mp4");
  assert.match(download.headers.get("Content-Disposition")??"",/attachment; filename="instagram-/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()),BODY);
  assert.equal((await getDownload(initial.id,false)).status,302);
});

test("reject unsigned, cross-site, stale, invalid media and missing selected target",async()=>{
  clear();
  const p=await makeDraft();
  const input={target:"tiktok",expected_updated_at:p.updated_at};
  assert.equal((await request(p.id,"import-video",input,{login:false})).status,302);
  assert.equal((await request(p.id,"import-video",input,{origin:"https://evil.example"})).status,403);
  assert.equal((await request(p.id,"import-video",input,{csrf:"wrong"})).status,403);
  assert.equal((await request(p.id,"import-video",{target:"facebook",expected_updated_at:p.updated_at})).status,400);
  assert.equal((await request(p.id,"import-video",{target:"tiktok",expected_updated_at:"2020-01-01"})).status,409);
  assert.deepEqual(requests,[]);
  malicious=true;
  assert.notEqual((await request(p.id,"import-video",input)).status,200);
  malicious=false;oversize=true;
  assert.notEqual((await request(p.id,"import-video",input)).status,200);
  assert.equal((await getPost(db,p.id))!.tiktok_video,TT);
  oversize=false;
  await db.prepare("UPDATE posts SET tiktok_enabled=0 WHERE id=?").bind(p.id).run();
  assert.equal((await request(p.id,"import-video",input)).status,409);
  await db.prepare("UPDATE posts SET tiktok_enabled=1,approved_at=? WHERE id=?")
    .bind(new Date().toISOString(),p.id).run();
  assert.equal((await request(p.id,"import-video",input)).status,409);
  assert.equal((await getPost(db,p.id))!.tiktok_video,TT);
});

test("Instagram Reel source is save-fenced, must belong to post and cannot mix photos",async()=>{
  const p=await makeDraft();
  const makeForm=(source:string,items="[]")=>{
    const f=new FormData();
    f.set("p_instagram","1");
    f.set("ig_caption","Reel");
    f.set("ig_frame","4:5");
    f.set("ig_items",items);
    f.set("ig_video_source",source);
    return f;
  };
  assert.deepEqual(parseEditorForm(makeForm(FB),p,"Europe/Copenhagen").errors,[]);
  assert.match(parseEditorForm(makeForm("https://evil.example/forged.mp4"),p,"Europe/Copenhagen").errors.join(" "),/must already belong/);
  assert.match(parseEditorForm(makeForm(FB,JSON.stringify([{url:"x",mode:"crop",bg:"dark",cx:0.5,cy:0.5,zoom:1}])),p,"Europe/Copenhagen").errors.join(" "),/either Instagram photos or a Reel/);
});

test("Instagram-only MP4 upload can attach without enabling a publishing platform",async()=>{
  const p=await createPost(db,{message:"Reel-only",images:[],facebook_enabled:false,tiktok_enabled:false,
    scheduled_at:null,created_by:"test",bluesky:null});
  const version=(await saveEditorDraft(db,p.id,p.updated_at,next(p),null,
    {caption:"Reel",frame:"4:5",items:[]}))!;
  assert.ok(version);
  const env={DB:db,UPLOADS:bucket} as Env;
  const grant=await createUpload(env,ORIGIN,{filename:"reel.mp4",actor:"GSGrimoire"});
  const uploaded=await handleUploadPut(new Request(grant.upload_url,{
    method:"PUT",headers:{"Content-Length":String(MP4.length)},body:MP4,
  }),env);
  assert.equal(uploaded.status,200,await uploaded.clone().text());
  const attached=await request(p.id,"attach-video",{
    reference:grant.reference,expected_updated_at:version,facebook:false,tiktok:false,bluesky:false,instagram:true,
  });
  assert.equal(attached.status,200,await attached.clone().text());
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.instagram?.video,grant.reference);
  assert.equal(saved.video,null);
  assert.equal(saved.approved_at,null);
  assert.equal((await getDownload(p.id)).status,200);
});
