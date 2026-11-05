// Open in X: a logged, new-tab link to X's composer on the draft and published
// pages. Route checks run through the real handleWeb in workerd.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost,recentAudit} from "../src/db.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import {xCompose,xSource,X_SHARE_JS} from "../src/x-share.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="x-share-test-cookie-secret";
let mf:Miniflare,db:D1Database;
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;

before(async()=>{
  const out=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:out.outputFiles[0].text,compatibilityDate:"2026-09-01",
    compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:"864201",TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>{await mf?.dispose();});

const cookie=async()=>SESSION_COOKIE+"="+await makeSession(signer,"GSGrimoire");
async function press(id:string,opts:{origin?:string;csrf?:string;signedIn?:boolean}={}){
  const raw=await makeSession(signer,"GSGrimoire");
  const csrf=opts.csrf??await csrfToken(signer,{login:"GSGrimoire",raw} as Session);
  return mf.dispatchFetch(ORIGIN+"/post/"+id+"/x-opened",{method:"POST",redirect:"manual",
    body:new URLSearchParams({csrf}).toString(),headers:{Origin:opts.origin??ORIGIN,
      "Sec-Fetch-Site":opts.origin?"cross-site":"same-origin",
      ...(opts.signedIn===false?{}:{Cookie:SESSION_COOKIE+"="+raw}),
      "Content-Type":"application/x-www-form-urlencoded"}});
}
async function page(id:string){
  return (await mf.dispatchFetch(ORIGIN+"/post/"+id,{headers:{Cookie:await cookie()}})).text();
}
const draft=()=>createPost(db,{message:"The Black Kiln is open. #dnd",images:[],scheduled_at:null,created_by:"test",
  bluesky:{caption:"Short kiln teaser",images:[],patreon:{url:"https://www.patreon.com/posts/1",title:"T",description:"D"}}});
const auditCount=async(id:string)=>(await recentAudit(db,200)).filter(r=>r.action==="x-opened"&&r.post_id===id).length;

test("the composer link carries encoded text and link, and only http links",()=>{
  const x=xCompose("Rage & ruin #dnd","https://www.patreon.com/posts/1?a=1");
  assert.equal(x.href,"https://x.com/intent/tweet?text=Rage%20%26%20ruin%20%23dnd&url=https%3A%2F%2Fwww.patreon.com%2Fposts%2F1%3Fa%3D1");
  assert.equal(x.note,"");
  assert.doesNotMatch(xCompose("Hi","javascript:alert(1)").href,/url=/);
  assert.doesNotMatch(xCompose("See https://a.example/x","https://a.example/x").href,/url=/);
  assert.equal(xCompose(" ","").empty,true);
});

test("long captions are flagged instead of silently cut",()=>{
  assert.match(xCompose("a".repeat(281),"").note,/About 281 characters/);
  assert.equal(xCompose("a".repeat(280),"").note,"");
  assert.match(xCompose("a".repeat(270),"https://a.example").note,/About 294 characters/);
  const long=xCompose("a".repeat(1500),"");
  assert.match(long.note,/first 1,000 characters/);
  assert.equal(long.href.length,"https://x.com/intent/tweet?text=".length+1000);
});

test("the length estimate follows X's weighting for emoji and links",()=>{
  assert.equal(xCompose("😀".repeat(140),"").note,"");
  assert.match(xCompose("😀".repeat(150),"").note,/About 300 characters/);
  assert.match(xCompose("日".repeat(141),"").note,/About 282 characters/);
  const longLink="https://www.patreon.com/posts/"+"a".repeat(300);
  assert.equal(xCompose("See "+longLink,"").note,"");
  assert.equal(xCompose("Free in the Archive: patreon.com/GSGrimoire "+"a".repeat(230),"").note,"");
  assert.match(xCompose("a".repeat(270)+" patreon.com/GSGrimoire","").note,/About 294 characters/);
});

test("Bluesky text comes first and disabled targets are ignored",async()=>{
  const p=await draft();
  assert.deepEqual(xSource(p),{text:"Short kiln teaser",link:"https://www.patreon.com/posts/1"});
  assert.equal(xSource({...p,bluesky:null}).text,p.message);
  assert.equal(xSource({...p,bluesky:null,facebook_enabled:false}).text,"");
});

test("the browser script parses and contains no outside references in xCompose",()=>{
  assert.doesNotThrow(()=>new Function(X_SHARE_JS));
  const compose=new Function(X_SHARE_JS.split("(() => {")[0]+";return xCompose;")();
  assert.deepEqual(compose("Hello","https://a.example"),xCompose("Hello","https://a.example"));
});

test("the script is served to signed-in users under the page's CSP",async()=>{
  const res=await mf.dispatchFetch(ORIGIN+"/x-share.js",{headers:{Cookie:await cookie()}});
  assert.equal(res.status,200);
  assert.match(res.headers.get("content-type")??"",/javascript/);
  await res.text();
});

test("the draft page shows a new-tab link, and one press greys it out on both pages",async()=>{
  const p=await draft();
  const before=await page(p.id);
  assert.match(before,/id="draft-editor"/);
  assert.match(before,/href="https:\/\/x\.com\/intent\/tweet\?text=Short%20kiln%20teaser[^"]*" target="_blank" rel="noopener noreferrer" data-x-open/);
  assert.match(before,/src="\/x-share\.js"/);

  const res=await press(p.id);
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{ok:true,first:true});
  const after=await getPost(db,p.id);
  assert.ok(after?.x_opened_at);
  assert.equal(after?.updated_at,p.updated_at,"an open editor must not hit the version fence");
  assert.equal(await auditCount(p.id),1);
  const greyDraft=await page(p.id);
  assert.match(greyDraft,/<button type="button" disabled>Opened in X<\/button>/);
  assert.match(greyDraft,/data-x-open>Reopen in X<\/a>/);
  assert.doesNotMatch(greyDraft,/>Open in X</);

  await db.prepare("UPDATE posts SET status='published',approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id).run();
  const greyPublished=await page(p.id);
  assert.doesNotMatch(greyPublished,/id="draft-editor"/);
  assert.match(greyPublished,/<button type="button" disabled>Opened in X<\/button>/);
  assert.match(greyPublished,/data-x-open>Reopen in X<\/a>/);
  assert.match(greyPublished,/not that it was posted/);
});

test("a post published without pressing it still offers the button, and logging there greys the draft view too",async()=>{
  const p=await draft();
  await db.prepare("UPDATE posts SET status='published',approved_at=? WHERE id=?").bind(new Date().toISOString(),p.id).run();
  assert.match(await page(p.id),/data-x-open/);
  assert.equal((await press(p.id)).status,200);
  assert.match(await page(p.id),/Opened in X<\/button>/);
  await db.prepare("UPDATE posts SET status='draft',approved_at=NULL WHERE id=?").bind(p.id).run();
  assert.match(await page(p.id),/Opened in X<\/button>/);
});

test("a repeat press keeps the first time and logs once",async()=>{
  const p=await draft();
  await press(p.id);
  const first=(await getPost(db,p.id))?.x_opened_at;
  assert.deepEqual(await (await press(p.id)).json(),{ok:true,first:false});
  assert.equal((await getPost(db,p.id))?.x_opened_at,first);
  assert.equal(await auditCount(p.id),1);
  assert.equal((await recentAudit(db,200)).filter(r=>r.action==="x-reopened"&&r.post_id===p.id).length,1);
});

test("a press that never became a post can be reopened with the revised text",async()=>{
  const p=await draft();
  await press(p.id);
  const first=(await getPost(db,p.id))?.x_opened_at;
  await db.prepare("UPDATE bluesky_targets SET caption='Revised teaser' WHERE post_id=?").bind(p.id).run();
  const revised=await page(p.id);
  assert.match(revised,/href="https:\/\/x\.com\/intent\/tweet\?text=Revised%20teaser[^"]*" target="_blank" rel="noopener noreferrer" data-x-open>Reopen in X/);
  assert.match(revised,/Opened in X<\/button>/);
  await db.prepare("UPDATE posts SET status='failed' WHERE id=?").bind(p.id).run();
  assert.match(await page(p.id),/data-x-open>Reopen in X/);
  assert.equal((await press(p.id)).status,200);
  const after=await getPost(db,p.id);
  assert.equal(after?.x_opened_at,first);
  assert.equal(after?.status,"failed");
  assert.equal(await auditCount(p.id),1);
});

test("a post with nothing to send keeps its opened record without a link",async()=>{
  const p=await draft();
  await press(p.id);
  await db.prepare("UPDATE bluesky_targets SET caption='',patreon=NULL WHERE post_id=?").bind(p.id).run();
  await db.prepare("UPDATE posts SET message='',status='published' WHERE id=?").bind(p.id).run();
  const html=await page(p.id);
  assert.match(html,/Opened in X<\/button>/);
  assert.match(html,/<p data-x-link hidden>/);
});

test("logging refuses cross-site, bad CSRF and signed-out requests",async()=>{
  const p=await draft();
  assert.equal((await press(p.id,{origin:"https://evil.example"})).status,403);
  assert.equal((await press(p.id,{csrf:"wrong"})).status,403);
  assert.equal((await press(p.id,{signedIn:false})).status,302);
  assert.equal((await getPost(db,p.id))?.x_opened_at??null,null);
  assert.equal(await auditCount(p.id),0);
});

test("rejected and cancelled posts are not offered, and pressing changes nothing else",async()=>{
  for(const status of ["rejected","cancelled"]){
    const p=await draft();
    await db.prepare("UPDATE posts SET status=? WHERE id=?").bind(status,p.id).run();
    assert.doesNotMatch(await page(p.id),/data-x-open/);
    assert.equal((await press(p.id)).status,409);
    assert.equal((await getPost(db,p.id))?.status,status);
  }
  const p=await draft();
  await press(p.id);
  const after=await getPost(db,p.id);
  assert.equal(after?.status,"draft");
  assert.equal(after?.approved_at,null);
  assert.equal(after?.bluesky?.status,"draft");
});
