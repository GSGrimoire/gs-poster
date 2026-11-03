/** Production OAuth consent route running in isolated workerd with a provider double. */
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="oauth-route-security-test";
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
let mf:Miniflare;
before(async()=>{
  const out=await build({entryPoints:["test/fixtures/oauth-consent-entry.ts"],bundle:true,
    format:"esm",platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,script:out.outputFiles[0].text,
    compatibilityDate:"2026-09-01",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"}}));
});
after(async()=>mf?.dispose());

async function auth(){
  const raw=await makeSession(signer,"GSGrimoire");
  return {raw,csrf:await csrfToken(signer,{login:"GSGrimoire",raw} as Session)};
}
async function consent(a:Awaited<ReturnType<typeof auth>>){
  const r=await mf.dispatchFetch(ORIGIN+"/authorize?client_id=example-app",{
    headers:{Cookie:SESSION_COOKIE+"="+a.raw},redirect:"manual"});
  assert.equal(r.status,200,await r.clone().text());
  const html=await r.text();
  const handle=html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle);
  assert.ok(html.includes('name="csrf" value="'+a.csrf+'"'));
  assert.match(r.headers.get("Set-Cookie")??"",/__Host-consent-handle=/);
  assert.equal(r.headers.get("X-Frame-Options"),"DENY");
  return handle;
}
async function count(){
  const r=await mf.dispatchFetch(ORIGIN+"/mock-state");
  return r.json() as Promise<{approved:number;denied:number;completed:number}>;
}
async function post(a:Awaited<ReturnType<typeof auth>>,handle:string,opts:{
  site?:string;origin?:string;csrf?:string;decision?:string;withProviderCookie?:boolean;
  session?:string;
}={}){
  const origin=opts.origin??ORIGIN,site=opts.site??"same-origin";
  const body=new URLSearchParams({csrf:opts.csrf??a.csrf,handle,decision:opts.decision??"approve",
    scope:"draft:read"});
  return mf.dispatchFetch(ORIGIN+"/authorize",{
    method:"POST",redirect:"manual",headers:{
      Cookie:SESSION_COOKIE+"="+(opts.session??a.raw)+
        (opts.withProviderCookie===false?"":"; __Host-consent-handle="+handle),
      Origin:origin,"Sec-Fetch-Site":site,"Content-Type":"application/x-www-form-urlencoded",
    },body:body.toString(),
  });
}

test("provider-bound GET includes an additional per-session CSRF field",async()=>{
  const a=await auth(),h=await consent(a);
  assert.match(h,/^mock-consent-/);
});

test("same-origin and CSRF guards protect both Approve and Deny before provider calls",async()=>{
  const a=await auth(),h=await consent(a);
  const beforeState=await count();
  const invalid=[
    {origin:"https://evil.example",site:"cross-site"},
    {origin:"https://evil.example",site:"same-origin"},
    {origin:"null",site:"cross-site"},
    {site:"cross-site"},
    {csrf:"bad"}, {csrf:""},
  ];
  for(const attempt of invalid)for(const decision of ["approve","deny"]){
    const r=await post(a,h,{...attempt,decision});
    assert.equal(r.status,403,await r.text());
  }
  const after=await count();
  assert.deepEqual({approved:after.approved,denied:after.denied},
    {approved:beforeState.approved,denied:beforeState.denied});
  const ok=await post(a,h);
  assert.equal(ok.status,302,await ok.clone().text());
  assert.match(ok.headers.get("Location")??"",/^https:\/\/client\.example\/cb/);
});

test("Deny and Origin:null with same-origin Fetch Metadata remain usable",async()=>{
  const a=await auth(),h=await consent(a);
  const denied=await post(a,h,{origin:"null",site:"same-origin",decision:"deny"});
  assert.equal(denied.status,302);
  assert.match(denied.headers.get("Location")??"",/access_denied/);
});

test("no active GitHub session, revoked login or provider cookie cannot confer approval",async()=>{
  const a=await auth(),h=await consent(a);
  const beforeState=await count();
  const revoked=await mf.dispatchFetch(ORIGIN+"/authorize",{method:"POST",redirect:"manual",
    headers:{Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",
      "Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({handle:h,csrf:a.csrf,decision:"approve"}).toString()});
  assert.equal(revoked.status,401);
  const unbound=await post(a,h,{withProviderCookie:false});
  assert.notEqual(unbound.status,302,"the OAuth helper must refuse an unbound handle");
  const after=await count();
  assert.equal(after.approved,beforeState.approved);
  assert.equal(after.denied,beforeState.denied);
});

test("single-use consent handle cannot approve twice",async()=>{
  const a=await auth(),h=await consent(a);
  const accepted=await post(a,h);
  assert.equal(accepted.status,302);
  const beforeState=await count();
  const replay=await post(a,h);
  assert.notEqual(replay.status,302);
  const after=await count();
  assert.equal(after.approved,beforeState.approved);
});
