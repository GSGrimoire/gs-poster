// Issue #33: reorder photos per platform in the editor. The order field may
// only rearrange the saved photos; removal stays separate; each platform's
// order is independent. Real bundled handleWeb in workerd.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {readOrder} from "../src/draft-editor.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="order-test-cookie-secret";
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const IMG=(n:number)=>"https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/main/test/"+n+".png";
const MSG="Order test. Free in the Archive: patreon.com/GSGrimoire";
let mf:Miniflare,db:D1Database;

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:out.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:"1",TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

async function save(p:{id:string;updated_at:string},fields:Record<string,string>){
  const raw=await makeSession(signer,"GSGrimoire");
  const csrf=await csrfToken(signer,{login:"GSGrimoire",raw} as Session);
  return mf.dispatchFetch(ORIGIN+"/post/"+p.id+"/save",{method:"POST",redirect:"manual",
    headers:{Origin:ORIGIN,"Sec-Fetch-Site":"same-origin","Content-Type":"application/x-www-form-urlencoded",
      Cookie:SESSION_COOKIE+"="+raw,"X-GS-Autosave":"1"},
    body:new URLSearchParams({csrf,expected_updated_at:p.updated_at,...fields}).toString()});
}
async function draft(o:{bluesky?:boolean;tiktok?:boolean}={}){
  return createPost(db,{message:MSG,label:"Order",release:null,images:[IMG(0),IMG(1),IMG(2)],video:null,created_by:"test",
    scheduled_at:null,facebook_enabled:true,tiktok_enabled:!!o.tiktok,tiktok_images:o.tiktok?[IMG(7),IMG(8),IMG(9)]:undefined,
    bluesky:o.bluesky?{caption:"Order #GSGrimoire",images:[{url:IMG(0),alt:"zero"},{url:IMG(1),alt:"one"},{url:IMG(2),alt:"two"}],video:null,patreon:null}:null} as any);
}

test("readOrder accepts only an exact rearrangement",()=>{
  const f=(v?:string)=>{const d=new FormData();if(v!==undefined)d.set("o",v);return d;};
  assert.deepEqual(readOrder(f(),"o",3),[0,1,2],"missing keeps the saved order");
  assert.deepEqual(readOrder(f("2,0,1"),"o",3),[2,0,1]);
  for(const bad of ["0,0,1","0,1","0,1,2,3","3,0,1","a,b,c","-1,0,1","0, 1,2","1.0,0,2"])
    assert.equal(readOrder(f(bad),"o",3),null,bad);
});

test("Facebook order is saved; removal applies to the saved position",async()=>{
  const p=await draft();
  const r=await save(p,{p_facebook:"1",message:MSG,order_fb:"2,0,1",remove_fb_0:"1"});
  assert.equal(r.status,200,await r.clone().text());
  assert.deepEqual((await getPost(db,p.id))!.images,[IMG(2),IMG(1)],"photo 0 removed, the rest in the new order");
});

test("Bluesky order carries each description with its photo; TikTok's own gallery orders independently",async()=>{
  const p=await draft({bluesky:true,tiktok:true});
  const r=await save(p,{p_facebook:"1",p_bluesky:"1",p_tiktok:"1",message:MSG,bs_caption:"Order #GSGrimoire",
    bs_alt_0:"zero",bs_alt_1:"one",bs_alt_2:"two",order_bs:"1,2,0",order_tt:"2,1,0"});
  assert.equal(r.status,200,await r.clone().text());
  const s=(await getPost(db,p.id))!;
  assert.deepEqual(s.bluesky!.images.map(i=>i.alt),["one","two","zero"]);
  assert.deepEqual(s.bluesky!.images.map(i=>i.url),[IMG(1),IMG(2),IMG(0)]);
  assert.deepEqual(s.tiktok_images,[IMG(9),IMG(8),IMG(7)]);
  assert.deepEqual(s.images,[IMG(0),IMG(1),IMG(2)],"Facebook untouched");
});

test("a forged order cannot add, repeat or drop photos, and saves nothing",async()=>{
  const p=await draft();
  for(const order_fb of ["0,0,1","0,1","5,0,1"]){
    const r=await save(p,{p_facebook:"1",message:MSG+" changed",order_fb});
    assert.equal(r.status,400,order_fb);
    assert.match((await r.json() as any).error,/photo order/);
  }
  const s=(await getPost(db,p.id))!;
  assert.deepEqual(s.images,[IMG(0),IMG(1),IMG(2)]);
  assert.equal(s.message,MSG);
});

test("the editor shows move buttons and an order field per platform with two or more photos",async()=>{
  const p=await draft({bluesky:true});
  const raw=await makeSession(signer,"GSGrimoire");
  const html=await (await mf.dispatchFetch(ORIGIN+"/post/"+p.id,{headers:{Cookie:SESSION_COOKIE+"="+raw}})).text();
  assert.match(html,/name="order_fb" value="0,1,2"/);
  assert.match(html,/name="order_bs" value="0,1,2"/);
  assert.match(html,/aria-label="Move Facebook photo 1 later"/);
  assert.doesNotMatch(html,/name="order_tt"/,"TikTok shares the Facebook gallery here, so it has no order of its own");
});

test("late Bluesky activation copies selected existing photos without changing Facebook",async()=>{
  const p=await draft();
  const r=await save(p,{p_facebook:"1",p_bluesky:"1",message:MSG,bs_caption:"Copied to Bluesky",
    bs_add_photos:"2,0",bs_add_alt_2:"Third photo",bs_add_alt_0:"First photo"});
  assert.equal(r.status,200,await r.clone().text());
  const updated=(await getPost(db,p.id))!;
  assert.deepEqual(updated.images,p.images);
  assert.deepEqual(updated.bluesky?.images,[
    {url:IMG(2),alt:"Third photo"},{url:IMG(0),alt:"First photo"},
  ]);
  assert.equal(updated.approved_at,null,"copying media cannot approve publication");
});

test("Bluesky can copy a TikTok gallery photo when enabled later",async()=>{
  const p=await draft({tiktok:true});
  const r=await save(p,{p_facebook:"1",p_tiktok:"1",p_bluesky:"1",message:MSG,
    bs_caption:"TikTok artwork on Bluesky",bs_add_photos:"5",bs_add_alt_5:"Ninth photo"});
  assert.equal(r.status,200,await r.clone().text());
  const updated=(await getPost(db,p.id))!;
  assert.deepEqual(updated.bluesky?.images,[{url:IMG(9),alt:"Ninth photo"}]);
  assert.deepEqual(updated.tiktok_images,p.tiktok_images,"TikTok gallery remains independent");
});

test("Bluesky copies refuse forged indices, duplicates and over-limit galleries",async()=>{
  const p=await draft({bluesky:true});
  for(const bs_add_photos of ["0,0","999","-1","0,,1","0,1,2,3,4","0,1"]){
    const r=await save(p,{p_facebook:"1",p_bluesky:"1",message:MSG,
      bs_caption:"No change",bs_add_photos});
    assert.equal(r.status,400,bs_add_photos);
  }
  const updated=(await getPost(db,p.id))!;
  assert.deepEqual(updated.bluesky?.images,p.bluesky?.images);
  assert.equal(updated.approved_at,null);
});

test("editor exposes an owned-media Bluesky picker and separate ordering controls",async()=>{
  const p=await draft({bluesky:true,tiktok:true});
  const raw=await makeSession(signer,"GSGrimoire");
  const html=await (await mf.dispatchFetch(ORIGIN+"/post/"+p.id,{headers:{Cookie:SESSION_COOKIE+"="+raw}})).text();
  assert.match(html,/id="bs-copy-drop"/);
  assert.match(html,/data-copy-bs="0"/);
  assert.match(html,/name="bs_add_photos"/);
  assert.match(html,/data-copy-index="0"/);
  for(const platform of ["facebook","bluesky","tiktok"])
    assert.match(html,new RegExp('data-media="'+platform+'" data-order="order_'));
});
