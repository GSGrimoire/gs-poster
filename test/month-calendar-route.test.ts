import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,ensureSchema,getPost} from "../src/db.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import {toLocalInput,localToUtc} from "../src/time.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="month-interactive-test-only";
const ZONE="Europe/Copenhagen";
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
let mf:Miniflare,db:D1Database;

before(async()=>{
  const built=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:built.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire",APPROVE_PIN:"1234",TIMEZONE:ZONE}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>mf?.dispose());

test("signed-in Month renders drag and click actions, rejects wrong PIN and preserves unapproved draft after move",async()=>{
  const oldAt=new Date(Date.now()+5*86400_000);
  const newAt=new Date(Date.now()+7*86400_000);
  const oldLocal=toLocalInput(oldAt,ZONE);
  const proposed=toLocalInput(newAt,ZONE);
  const post=await createPost(db,{message:"Month reschedule test",label:"Month card",images:[],
    created_by:"test",scheduled_at:oldAt.toISOString(),facebook_enabled:true});
  const raw=await makeSession(signer,"GSGrimoire");
  const session={raw,login:"GSGrimoire"} as Session;
  const csrf=await csrfToken(signer,session);
  const month=oldLocal.slice(0,7);
  const cookie=SESSION_COOKIE+"="+raw;
  const get=await mf.dispatchFetch(ORIGIN+"/calendar?view=month&month="+month,{
    headers:{Cookie:cookie}});
  assert.equal(get.status,200);
  const html=await get.text();
  assert.match(html,new RegExp('draggable="true" data-id="'+post.id+'"'));
  assert.match(html,/id="month-cal-form"/);
  assert.match(html,/href="\/calendar\?view=week/);
  assert.match(html,/src="\/calendar-month\.js"/);
  const js=await mf.dispatchFetch(ORIGIN+"/calendar-month.js",{headers:{Cookie:cookie}});
  assert.equal(js.status,200);
  assert.match(await js.text(),/dialog\.showModal/);

  const send=(pin:string,version:string,returnTo:string)=>mf.dispatchFetch(
    ORIGIN+"/post/"+post.id+"/reschedule",{method:"POST",redirect:"manual",
      headers:{Cookie:cookie,Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",
        "Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({csrf,pin,when:proposed,return_to:returnTo,expected_updated_at:version}).toString()});
  let result=await send("invalid",post.updated_at,"/calendar?view=month&month="+month);
  assert.equal(result.status,403);
  assert.equal((await getPost(db,post.id))?.scheduled_at,post.scheduled_at);
  result=await send("1234",post.updated_at,"/calendar?view=month&month="+month);
  assert.equal(result.status,302);
  assert.equal(result.headers.get("location"),"/calendar?view=month&month="+month);
  const saved=(await getPost(db,post.id))!;
  assert.equal(saved.scheduled_at,localToUtc(proposed,ZONE).toISOString());
  assert.equal(saved.status,"draft");
  assert.equal(saved.approved_at,null,"drag-to-day must not approve or publish");
  result=await send("1234",post.updated_at,"/calendar?view=month&month="+month);
  assert.equal(result.status,409,"stale optimistic version must block replay");
  assert.equal((await getPost(db,post.id))?.scheduled_at,saved.scheduled_at);
});
