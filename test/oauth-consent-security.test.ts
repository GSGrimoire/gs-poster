/** OAuth consent route defenses on top of the provider's single-use browser-bound handle.
 * Tests the real handleWeb route with an isolated provider and database.
 */
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare} from "miniflare";
import {ensureSchema} from "../src/db.ts";
import {handleWeb} from "../src/web.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="oauth-route-security-test";
let mf:Miniflare,db:D1Database;
before(async()=>{
  mf=new Miniflare({modules:true,script:"export default { fetch(){return new Response('test')} };",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]});
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
});
after(async()=>mf?.dispose());

function mockProvider(){
  const state={parsed:0,begun:0,approved:0,denied:0,completed:0};
  const request={clientId:"example-app",scope:["draft:read"],redirectUri:"https://client.example/cb"};
  return {state,helpers:{
    async parseAuthRequest(){state.parsed++;return request;},
    async describeConsent(){return {clientName:"Client",clientDomain:null,redirectHost:"client.example",
      redirectIsLoopback:false,scope:["draft:read"]};},
    async beginConsent(){state.begun++;return {handle:"consent-handle",headers:new Headers({
      "Set-Cookie":"__Host-oauth-consent=bound; Secure; HttpOnly; SameSite=Lax; Path=/",
      "X-Frame-Options":"DENY"})};},
    async denyConsent(_req:Request,handle:string){
      assert.equal(handle,"consent-handle");state.denied++;
      return {redirectTo:"https://client.example/cb?error=access_denied",headers:new Headers()};
    },
    async approveConsent(_req:Request,handle:string,options:{scope:string[]}){
      assert.equal(handle,"consent-handle");assert.deepEqual(options.scope,["draft:read"]);
      state.approved++;return {request,headers:new Headers()};
    },
    async completeAuthorization(){state.completed++;return {redirectTo:"https://client.example/cb?code=dummy"};},
  }};
}
async function session(login="GSGrimoire") {
  const env={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
  const raw=await makeSession(env,login);
  return {raw, csrf:await csrfToken(env,{login,raw} as Session)};
}
function environment(provider:ReturnType<typeof mockProvider>,allowed="gsgrimoire"):Env{
  return {DB:db,COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:allowed,
    OAUTH_PROVIDER:provider.helpers} as unknown as Env;
}
async function post(env:Env,auth:{raw:string;csrf:string},options:{
  origin?:string;site?:string;csrf?:string;decision?:string;cookie?:string;
}={}){
  const form=new URLSearchParams({handle:"consent-handle",scope:"draft:read",
    csrf:options.csrf??auth.csrf,decision:options.decision??"approve"});
  const headers=new Headers({"Content-Type":"application/x-www-form-urlencoded",
    Cookie:SESSION_COOKIE+"="+auth.raw+(options.cookie?"; "+options.cookie:""),
    "Sec-Fetch-Site":options.site??"same-origin"});
  if(options.origin!==undefined)headers.set("Origin",options.origin);
  else headers.set("Origin",ORIGIN);
  return handleWeb(new Request(ORIGIN+"/authorize",{method:"POST",headers,body:form}),env);
}

test("consent GET provides both a provider binding and a session CSRF token",async()=>{
  const auth=await session(),provider=mockProvider(),env=environment(provider);
  const response=await handleWeb(new Request(ORIGIN+"/authorize?client_id=example-app",{
    headers:{Cookie:SESSION_COOKIE+"="+auth.raw},
  }),env);
  assert.equal(response.status,200);
  assert.match(response.headers.get("Set-Cookie")??"",/__Host-oauth-consent=/);
  assert.equal(response.headers.get("X-Frame-Options"),"DENY");
  const html=await response.text();
  assert.ok(html.includes('name="csrf" value="'+auth.csrf+'"'));
  assert.match(html,/name="handle" value="consent-handle"/);
  assert.equal(provider.state.begun,1);
});

test("consent approve and deny require a correct signed-in session, origin and CSRF",async()=>{
  const auth=await session(),provider=mockProvider(),env=environment(provider);
  const variants=[
    {origin:"https://evil.example",site:"cross-site"},
    {origin:"null",site:"cross-site"},
    {origin:"https://evil.example",site:"same-origin"},
    {origin:ORIGIN,site:"cross-site"},
    {csrf:"forged"},
    {csrf:""},
  ];
  for(const v of variants)for(const decision of ["approve","deny"]){
    const response=await post(env,auth,{...v,decision});
    assert.equal(response.status,403,await response.text());
  }
  assert.equal(provider.state.approved,0);
  assert.equal(provider.state.denied,0);
  const ok=await post(env,auth);
  assert.equal(ok.status,302);
  assert.match(ok.headers.get("Location")??"",/^https:\/\/client\.example\/cb/);
  assert.equal(provider.state.approved,1);
  assert.equal(provider.state.completed,1);
  const denied=await post(env,auth,{decision:"deny"});
  assert.equal(denied.status,302);
  assert.equal(provider.state.denied,1);
  const nullOrigin=await post(env,auth,{origin:"null",site:"same-origin"});
  assert.equal(nullOrigin.status,302,"the site's Referrer-Policy may set Origin:null");
});

test("revoked or absent allowed session cannot approve, regardless of CSRF",async()=>{
  const auth=await session(),provider=mockProvider();
  const revoked=await post(environment(provider,"other-user"),auth);
  assert.equal(revoked.status,401);
  const unsigned=await handleWeb(new Request(ORIGIN+"/authorize",{method:"POST",headers:{
    Origin:ORIGIN,"Sec-Fetch-Site":"same-origin","Content-Type":"application/x-www-form-urlencoded",
  },body:new URLSearchParams({handle:"consent-handle",decision:"approve",csrf:auth.csrf})}),
    environment(provider));
  assert.equal(unsigned.status,401);
  assert.equal(provider.state.approved,0);
  assert.equal(provider.state.denied,0);
});
