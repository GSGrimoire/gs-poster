// Instagram preparation: crop and pad. Nothing here may send anything to
// Instagram. Covers the shared geometry (server and browser), strict input
// reading, save rules, the Images-binding render calls, fenced storage in real
// D1 and the signed-in-only render route, all in workerd where it matters.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {INSTAGRAM_PLAN_JS,instagramPlan,instagramSaveErrors,readInstagramItems,renderInstagram,
  countHashtags,defaultItem,type InstagramDraft} from "../src/instagram.ts";
import {createPost,deletePost,ensureSchema,getPost,saveEditorDraft,type EditorDraft} from "../src/db.ts";
import {parseEditorForm,postPhotos} from "../src/draft-editor.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="instagram-test-cookie-secret";
let mf:Miniflare,db:D1Database;
before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:out.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:"135790",TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

const IMG=(n:number)=>"https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/"+n+".png";

// ------------------------------------------------------------ geometry
test("crop fills the frame and keeps the chosen part",()=>{
  const p=instagramPlan(1920,1080,"4:5","crop",0.5,0.5,1);
  assert.deepEqual([p.outW,p.outH],[1080,1350]);
  assert.deepEqual(p.src,{x:528,y:0,w:864,h:1080});
  assert.deepEqual(p.dst,{x:0,y:0,w:1080,h:1350});
  assert.equal(instagramPlan(1920,1080,"4:5","crop",0,0.5,1).src.x,0,"focus at the left edge clamps inside");
  assert.equal(instagramPlan(1920,1080,"4:5","crop",1,0.5,1).src.x,1920-864);
  const z=instagramPlan(1920,1080,"4:5","crop",0.5,0.5,2);
  assert.deepEqual([z.src.w,z.src.h],[432,540]);
  assert.equal(instagramPlan(1920,1080,"4:5","crop",0.5,0.5,99).src.w,216,"zoom is capped at 4");
});

test("pad keeps the whole picture centred on the background",()=>{
  const p=instagramPlan(1080,1920,"4:5","pad",0,0,3);
  assert.deepEqual(p.src,{x:0,y:0,w:1080,h:1920});
  assert.deepEqual(p.dst,{x:161,y:0,w:759,h:1350});
  const wide=instagramPlan(2000,500,"1:1","pad",0.5,0.5,1);
  assert.deepEqual(wide.dst,{x:0,y:405,w:1080,h:270});
});

test("every frame stays inside Instagram's 4:5 to 1.91:1 range at 1080 px wide",()=>{
  for(const f of ["4:5","1:1","1.91:1"]){
    const p=instagramPlan(3000,3000,f,"crop",0.5,0.5,1);
    const r=p.outW/p.outH;
    assert.ok(r>=0.8-1e-9&&r<=1.91,f+" "+r);
    assert.ok(p.outW>=320&&p.outW<=1440);
  }
  assert.equal(instagramPlan(10,10,"bogus","crop",0.5,0.5,1).outH,1350,"unknown frame falls back to 4:5");
});

test("the browser gets the same function the server renders with",()=>{
  const plan=new Function(INSTAGRAM_PLAN_JS+"; return instagramPlan;")();
  for(const args of [[1920,1080,"4:5","crop",0.3,0.7,1.6],[640,1600,"1.91:1","pad",0.5,0.5,1],[1000,1000,"1:1","crop",1,0,4]] as const)
    assert.deepEqual(plan(...args),instagramPlan(...args));
});

// ------------------------------------------------------------ input and rules
test("item JSON is read strictly",()=>{
  assert.equal(readInstagramItems("not json"),null);
  assert.equal(readInstagramItems('{"url":"a"}'),null);
  assert.equal(readInstagramItems('[{"url":"a","mode":"crop","bg":"dark","cx":"0.5"}]'),null);
  assert.deepEqual(readInstagramItems('[{"url":"a","mode":"pad","bg":"white"}]'),[{url:"a",mode:"pad",cx:0.5,cy:0.5,zoom:1,bg:"white"}]);
});

test("save rules: own photos only, no repeats, limits enforced",()=>{
  const ok=new Set([IMG(1),IMG(2)]);
  const d=(o:Partial<InstagramDraft>):InstagramDraft=>({caption:"",frame:"4:5",items:[defaultItem(IMG(1))],...o});
  assert.deepEqual(instagramSaveErrors(d({}),ok),[]);
  assert.match(instagramSaveErrors(d({items:[defaultItem("https://evil.example/x.png")]}),ok)[0],/not one of this post's photos/);
  assert.match(instagramSaveErrors(d({items:[defaultItem(IMG(1)),defaultItem(IMG(1))]}),ok)[0],/twice/);
  const many=new Set(Array.from({length:11},(_,i)=>IMG(i)));
  assert.match(instagramSaveErrors(d({items:[...many].map(u=>defaultItem(u))}),many)[0],/at most 10/);
  assert.match(instagramSaveErrors(d({caption:Array.from({length:31},(_,i)=>"#t"+i).join(" ")}),ok)[0],/30 hashtags/);
  assert.match(instagramSaveErrors(d({frame:"3:4" as any}),ok)[0],/Choose an Instagram frame/);
  assert.match(instagramSaveErrors(d({items:[{...defaultItem(IMG(1)),zoom:9}]}),ok)[0],/out of range/);
  assert.match(instagramSaveErrors(d({items:[{...defaultItem(IMG(1)),bg:"red" as any}]}),ok)[0],/background/);
  assert.equal(countHashtags("#dnd and #battle_map, not a#b or &#39;"),2);
});

// ------------------------------------------------------------ server render
function fakeImages(width:number,height:number){
  const calls:any[]=[];
  const chain:any={
    transform(t:any){calls.push(["transform",t]);return chain;},
    output(o:any){calls.push(["output",o]);return {response:()=>new Response(new Uint8Array([0xff,0xd8,0xff]))};},
  };
  const binding={info:async()=>({format:"image/png",fileSize:1,width,height}),input:()=>chain} as unknown as ImagesBinding;
  return {binding,calls};
}
test("crop renders as one transform: trim the four sides, then cover to the exact frame",async()=>{
  const {binding,calls}=fakeImages(1920,1080);
  const out=await renderInstagram(binding,new Uint8Array([1]),"4:5",{...defaultItem("x"),cx:0.25});
  assert.deepEqual([...out],[0xff,0xd8,0xff]);
  const plan=instagramPlan(1920,1080,"4:5","crop",0.25,0.5,1);
  assert.deepEqual(calls[0],["transform",{trim:{left:plan.src.x,top:plan.src.y,
    right:1920-plan.src.x-plan.src.w,bottom:1080-plan.src.y-plan.src.h},width:1080,height:1350,fit:"cover"}]);
  assert.equal(calls[1][1].format,"image/jpeg");
  assert.equal(calls.length,2,"one transform: trim then resize, as Cloudflare orders them");
});
test("pad renders as fit pad on the chosen background",async()=>{
  const {binding,calls}=fakeImages(1080,1920);
  await renderInstagram(binding,new Uint8Array([1]),"1:1",{...defaultItem("x","pad"),bg:"parchment"});
  assert.deepEqual(calls[0],["transform",{width:1080,height:1080,fit:"pad",background:"#f4eee3"}]);
  assert.equal(calls[1][1].background,"#f4eee3");
});

// ------------------------------------------------------------ storage (real D1)
function editorDraft(p:any):EditorDraft{
  return {message:p.message,tiktok_caption:null,images:p.images,tiktok_images:p.tiktok_images,video:null,tiktok_video:null,
    facebook_enabled:true,tiktok_enabled:false,scheduled_at:null,label:p.label,release:p.release};
}
async function draft(){
  return createPost(db,{message:"Cave. Free in the Archive: patreon.com/GSGrimoire",label:"Cave",release:null,
    images:[IMG(1),IMG(2)],video:null,created_by:"test",scheduled_at:null,facebook_enabled:true,tiktok_enabled:false,bluesky:null} as any);
}
const IG:InstagramDraft={caption:"Cave #dnd",frame:"1:1",items:[{...defaultItem(IMG(2),"pad"),bg:"white"},defaultItem(IMG(1))]};

test("Instagram target saves in the same fenced transaction and reads back exactly",async()=>{
  const p=await draft();
  const v=await saveEditorDraft(db,p.id,p.updated_at,editorDraft(p),null,IG);
  assert.ok(v);
  const saved=(await getPost(db,p.id))!;
  assert.deepEqual(saved.instagram,IG);
  // Undefined (the MCP path) leaves Instagram alone.
  const v2=await saveEditorDraft(db,p.id,v!,{...editorDraft(p),message:"Edited. Free in the Archive: patreon.com/GSGrimoire"},null);
  assert.ok(v2);
  assert.deepEqual((await getPost(db,p.id))!.instagram,IG);
  // A stale version changes nothing, Instagram included.
  assert.equal(await saveEditorDraft(db,p.id,v!,editorDraft(p),null,null),null);
  assert.deepEqual((await getPost(db,p.id))!.instagram,IG);
  // Null removes it.
  assert.ok(await saveEditorDraft(db,p.id,v2!,editorDraft(p),null,null));
  assert.equal((await getPost(db,p.id))!.instagram,null);
});

test("an approved post's Instagram target cannot be changed",async()=>{
  const p=await draft();
  const v=(await saveEditorDraft(db,p.id,p.updated_at,editorDraft(p),null,IG))!;
  await db.prepare("UPDATE posts SET approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id).run();
  assert.equal(await saveEditorDraft(db,p.id,v,editorDraft(p),null,{...IG,caption:"Changed"}),null);
  assert.equal((await getPost(db,p.id))!.instagram!.caption,"Cave #dnd");
});

test("deleting a draft removes its Instagram target",async()=>{
  const p=await draft();
  await saveEditorDraft(db,p.id,p.updated_at,editorDraft(p),null,IG);
  assert.ok(await deletePost(db,p.id,["draft"]));
  const row=await db.prepare("SELECT 1 AS x FROM instagram_targets WHERE post_id=?").bind(p.id).first();
  assert.equal(row,null);
});

// ------------------------------------------------------------ editor form
test("editor form: Instagram may use this post's photos only, and may be the only platform",async()=>{
  const p=(await getPost(db,(await draft()).id))!;
  assert.deepEqual(postPhotos(p),[IMG(1),IMG(2)]);
  const form=(items:unknown,extra:Record<string,string>={})=>{
    const f=new FormData();
    for(const [k,v] of Object.entries({p_instagram:"1",ig_caption:"Cave",ig_frame:"4:5",ig_items:JSON.stringify(items),...extra}))f.set(k,v);
    return f;
  };
  const ok=parseEditorForm(form([defaultItem(IMG(2))]),p,"Europe/Copenhagen");
  assert.deepEqual(ok.errors,[]);
  assert.equal(ok.instagram!.items[0].url,IMG(2));
  assert.equal(ok.next!.facebook_enabled,false);
  const foreign=parseEditorForm(form([defaultItem("upload://"+"b".repeat(32)+".png")]),p,"Europe/Copenhagen");
  assert.match(foreign.errors.join(" "),/not one of this post's photos/);
  const garbled=parseEditorForm(form("x",{ig_items:"{"}),p,"Europe/Copenhagen");
  assert.match(garbled.errors.join(" "),/Could not read the Instagram/);
  const off=parseEditorForm(form([],{p_instagram:"0",p_facebook:"1"}),p,"Europe/Copenhagen");
  assert.equal(off.instagram,null,"turning Instagram off removes the target on save");
});

test("paused Instagram rejects an untrusted Reel reference and cannot bootstrap ownership",async()=>{
  const p=(await getPost(db,(await draft()).id))!;
  const forged="upload://"+"c".repeat(32)+".mp4";
  const unrelated="https://raw.githubusercontent.com/GSGrimoire/Other/main/missing.mp4";
  const paused={...p,instagram:null,instagram_paused:{
    caption:"Cave",frame:"4:5" as const,items:[],
  }};
  const form=(source:string,enabled:boolean)=>{
    const f=new FormData();
    for(const [key,value] of Object.entries({
      p_facebook:"1",p_instagram:enabled?"1":"0",ig_caption:"Cave",
      ig_frame:"4:5",ig_items:"[]",ig_video_source:source,
    }))f.set(key,value);
    return f;
  };
  for(const source of [forged,unrelated]){
    const off=parseEditorForm(form(source,false),paused,"Europe/Copenhagen");
    assert.match(off.errors.join(" "),/Instagram video must already belong to this post/,
      "a paused target must not accept an arbitrary MP4 or foreign private upload");
    assert.equal(off.instagram,undefined,"invalid form has no savable Instagram draft");

    const on=parseEditorForm(form(source,true),paused,"Europe/Copenhagen");
    assert.match(on.errors.join(" "),/Instagram video must already belong to this post/,
      "an active target must enforce the same source restriction");
  }
  // Existing Facebook, TikTok and Bluesky targets may supply a video.
  const fb="https://raw.githubusercontent.com/GSGrimoire/Images/main/video.mp4";
  const fromFacebook={...paused,video:fb};
  const selected=parseEditorForm(form(fb,false),fromFacebook,"Europe/Copenhagen");
  assert.deepEqual(selected.errors,[]);
  assert.equal(selected.instagram?.video,fb);
  // A previous Instagram-only verified upload remains editable while paused.
  // This exception preserves the exact stored value, not a new caller value.
  const trusted={...paused,instagram_paused:{...paused.instagram_paused,
    video:"upload://"+"d".repeat(32)+".mp4"}};
  assert.deepEqual(parseEditorForm(form(trusted.instagram_paused.video,false),trusted,
    "Europe/Copenhagen").errors,[]);
  assert.match(parseEditorForm(form(forged,false),trusted,
    "Europe/Copenhagen").errors.join(" "),/Instagram video must already belong/);
});

test("signed-in save cannot persist a forged video into a paused Instagram target",async()=>{
  const p=await draft();
  const version=await saveEditorDraft(db,p.id,p.updated_at,{
    ...editorDraft(p),instagram_enabled:false,
  },null,{caption:"Paused",frame:"4:5",items:[]});
  assert.ok(version);
  const paused=(await getPost(db,p.id))!;
  assert.equal(paused.instagram,null);
  assert.ok(paused.instagram_paused);
  const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
  const raw=await makeSession(signer,"GSGrimoire");
  const csrf=await csrfToken(signer,{login:"GSGrimoire",raw} as Session);
  const malicious="upload://"+"e".repeat(32)+".mp4";
  const body=new URLSearchParams({
    csrf,expected_updated_at:version!,p_facebook:"1",
    ig_caption:"Paused",ig_frame:"4:5",ig_items:"[]",ig_video_source:malicious,
  });
  const response=await mf.dispatchFetch(ORIGIN+"/post/"+p.id+"/save",{
    method:"POST",
    headers:{Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",
      Cookie:SESSION_COOKIE+"="+raw,"X-GS-Autosave":"1",Accept:"application/json",
      "Content-Type":"application/x-www-form-urlencoded"},
    body:body.toString(),redirect:"manual",
  });
  assert.equal(response.status,400,await response.clone().text());
  const saved=(await getPost(db,p.id))!;
  assert.equal(saved.updated_at,version,"failed validation must not write a new draft version");
  assert.equal(saved.instagram_paused?.video,undefined,"paused target remains free of the forged private reference");
  assert.equal(saved.approved_at,null,"no publish or approval side effects");
});

// ------------------------------------------------------------ render route
test("the rendered-photo route needs a signed-in editor and an existing photo",async()=>{
  const p=await draft();
  await saveEditorDraft(db,p.id,p.updated_at,editorDraft(p),null,IG);
  const anon=await mf.dispatchFetch(ORIGIN+"/instagram/"+p.id+"/0.jpg",{redirect:"manual"});
  assert.notEqual(anon.status,200);
  assert.notEqual(anon.headers.get("content-type"),"image/jpeg");
  await anon.arrayBuffer();
  const cookie=SESSION_COOKIE+"="+await makeSession({COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env,"GSGrimoire");
  const missing=await mf.dispatchFetch(ORIGIN+"/instagram/"+p.id+"/7.jpg",{headers:{Cookie:cookie}});
  assert.equal(missing.status,404); await missing.arrayBuffer();
  const noBinding=await mf.dispatchFetch(ORIGIN+"/instagram/"+p.id+"/0.jpg",{headers:{Cookie:cookie}});
  assert.equal(noBinding.status,503,"without the Images binding nothing is guessed"); await noBinding.arrayBuffer();
});
