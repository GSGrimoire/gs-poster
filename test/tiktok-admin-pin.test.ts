/** Owner PIN gates for TikTok administration, exercised through the real web router.
 * All credentials, account identifiers and PINs below are isolated test values.
 * No external TikTok request or publication is performed.
 */
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {ensureSchema,pinLocked} from "../src/db.ts";
import {ensureTikTokSchema} from "../src/tiktok.ts";
import {csrfToken,makeSession,SESSION_COOKIE,type Session} from "../src/session.ts";
import type {Env} from "../src/env.ts";

const ORIGIN="https://gs-poster.test";
const SECRET="test-only-tiktok-admin-session-secret";
const PIN="246810"; // test-only; never a production PIN
const TEST_KEY="test-only-tiktok-client-key";
const TEST_ENCRYPTION_KEY="test-only-not-a-real-key-12345678901234567890";
let mf:Miniflare,db:D1Database;
const signer={COOKIE_SECRET:SECRET,ALLOWED_GITHUB_LOGINS:"gsgrimoire"} as Env;
const filename="tiktok_verify_file.txt";

before(async()=>{
  const output=await build({entryPoints:["test/fixtures/web-entry.ts"],bundle:true,format:"esm",
    platform:"neutral",target:"es2022",write:false,external:["cloudflare:*","node:*"],
    conditions:["workerd","worker","browser"],mainFields:["module","main"],logLevel:"silent"});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:output.outputFiles[0].text,compatibilityDate:"2026-09-01",
    compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],
    bindings:{COOKIE_SECRET:SECRET,APPROVE_PIN:PIN,ALLOWED_GITHUB_LOGINS:"gsgrimoire",
      TIKTOK_CLIENT_KEY:TEST_KEY,TIKTOK_CLIENT_SECRET:"test-only-client-secret",
      TIKTOK_TOKEN_ENCRYPTION_KEY:TEST_ENCRYPTION_KEY,TIMEZONE:"Europe/Copenhagen"}}));
  db=await mf.getD1Database("DB") as unknown as D1Database;
  await ensureSchema(db);
  await ensureTikTokSchema(db);
});
after(async()=>{await mf?.dispose();});

async function auth(login="GSGrimoire"){
  const raw=await makeSession(signer,login);
  return {raw,csrf:await csrfToken(signer,{login,raw} as Session)};
}
async function submit(action:"connect"|"disconnect"|"verify",pin:string|null,
  options:{origin?:string;fetchSite?:string;csrf?:string;login?:string|null;confirm?:boolean;filename?:string}={}){
  const a=await auth(options.login??"GSGrimoire");
  const f=new URLSearchParams({csrf:options.csrf??a.csrf});
  if(pin!==null)f.set("pin",pin);
  if(action==="connect")f.set("video.upload","1");
  if(action==="disconnect"&&(options.confirm??true))f.set("confirm","yes");
  if(action==="verify"){
    f.set("filename",options.filename??filename);f.set("contents","verification-string-for-tests");
  }
  const headers:Record<string,string>={
    Origin:options.origin??ORIGIN,"Sec-Fetch-Site":options.fetchSite??"same-origin",
    "Content-Type":"application/x-www-form-urlencoded",
  };
  if(options.login!==null)headers.Cookie=SESSION_COOKIE+"="+a.raw;
  return mf.dispatchFetch(ORIGIN+"/tiktok/"+action,{method:"POST",
    headers,body:f.toString(),redirect:"manual"});
}
async function get(path:string,login="GSGrimoire",extraCookie=""){
  const a=await auth(login);
  return mf.dispatchFetch(ORIGIN+path,{
    headers:{Cookie:SESSION_COOKIE+"="+a.raw+(extraCookie?"; "+extraCookie:"")},
    redirect:"manual"});
}
async function states(){
  const result=await db.prepare("SELECT COUNT(*) AS n FROM tiktok_oauth_states").first<{n:number}>();
  return result?.n??0;
}
async function verification(){
  const row=await db.prepare("SELECT contents FROM tiktok_media_verification WHERE filename=?")
    .bind(filename).first<{contents:string}>();
  return row?.contents??null;
}
async function account(){
  const row=await db.prepare("SELECT open_id FROM tiktok_accounts WHERE account_key='primary'")
    .first<{open_id:string}>();
  return row?.open_id??null;
}
async function resetFailures(){
  await db.prepare("DELETE FROM pin_failures").run();
}

test("GET settings shows password inputs for connection and verification without exposing the PIN",async()=>{
  const response=await get("/tiktok/settings");
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/name="pin" id="tt-connect-pin"/);
  assert.match(html,/name="pin" id="tt-verify-pin"/);
  assert.match(html,/type="password" name="pin"/);
  assert.doesNotMatch(html,/value="246810"/);
  assert.match(html,/Connecting, disconnecting and hosting verification files require your approval PIN/);
});

test("all three administrative actions reject absent or wrong PIN before mutations",async()=>{
  await resetFailures();
  for(const action of ["connect","disconnect","verify"] as const){
    const beforeState=await states(),beforeMedia=await verification();
    for(const submitted of [null,"000000"]){
      const response=await submit(action,submitted);
      assert.equal(response.status,403,action+": "+await response.clone().text());
      assert.match(await response.text(),/Wrong PIN/);
    }
    assert.equal(await states(),beforeState,action+" must not create an OAuth state");
    assert.equal(await verification(),beforeMedia,action+" must not host verification contents");
    assert.equal(await account(),null,action+" must not change the account");
  }
  await resetFailures();
});

test("a forged cross-site request, bad CSRF or signed-in but nonallowlisted user cannot administer",async()=>{
  await resetFailures();
  const attempts=[
    {origin:"https://attacker.example",fetchSite:"cross-site"},
    {origin:"null",fetchSite:"cross-site"},
    {origin:"https://attacker.example",fetchSite:"same-origin"},
    {origin:ORIGIN,fetchSite:"cross-site"},
    {csrf:"bad-token"},
    {csrf:""},
    {login:"SomeOtherEditor"},
    {login:null},
  ];
  for(const attempt of attempts)for(const action of ["connect","disconnect","verify"] as const){
    const response=await submit(action,PIN,attempt);
    assert.notEqual(response.status,200,action+" accepted a forged request");
    assert.notEqual(response.status,303,action+" redirected a forged request as success");
  }
  assert.equal(await states(),0);
  assert.equal(await verification(),null);
  assert.equal(await account(),null);
  const attemptsRecorded=await db.prepare("SELECT COUNT(*) AS n FROM pin_failures").first<{n:number}>();
  assert.equal(attemptsRecorded?.n,0,"CSRF, session and origin checks must precede PIN checks");
});

test("correct PIN may host verification and disconnect an absent account without publishing",async()=>{
  await resetFailures();
  const response=await submit("verify",PIN);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(await verification(),"verification-string-for-tests");
  const result=await submit("disconnect",PIN);
  assert.equal(result.status,303,await result.clone().text());
  assert.equal(result.headers.get("Location"),"/tiktok/settings?notice=disconnected");
  assert.equal(await account(),null);
  assert.equal(await states(),0);
});

test("connected account displays a disconnect PIN, wrong PIN preserves its account record",async()=>{
  await db.prepare("INSERT INTO tiktok_accounts (account_key,open_id,token_cipher,scopes,connected_by,access_expires_at,refresh_expires_at,updated_at,lease_id,lease_until) VALUES ('primary',?,?,?,?,?,?,?,NULL,NULL)")
    .bind("test-only-open-id","fake-cipher-not-a-real-token","user.info.basic","GSGrimoire",
      1000000,10000000,new Date().toISOString()).run();
  try{
    const html=await (await get("/tiktok/settings")).text();
    assert.match(html,/name="pin" id="tt-disconnect-pin"/);
    assert.doesNotMatch(html,/name="pin" id="tt-connect-pin"/);
    const noConfirm=await submit("disconnect","000000",{confirm:false});
    assert.equal(noConfirm.status,403,"PIN still checked before accessing a connected account");
    const denied=await submit("disconnect","000000");
    assert.equal(denied.status,403);
    assert.equal(await account(),"test-only-open-id","wrong PIN cannot drop account credentials");
  }finally{
    await db.prepare("DELETE FROM tiktok_accounts WHERE account_key='primary'").run();
    await resetFailures();
  }
});

test("correct PIN creates a signed-in short-lived OAuth state, not an automatic connection",async()=>{
  const beforeState=await states();
  const res=await submit("connect",PIN);
  assert.equal(res.status,200,await res.clone().text());
  assert.match(await res.text(),/Continue to TikTok/);
  assert.match(res.headers.get("Set-Cookie")??"",/__Host-gsp_tiktok_state=/);
  assert.equal(await states(),beforeState+1);
  assert.equal(await account(),null,"consent initiation must not complete the account connection");
  const state=(res.headers.get("Set-Cookie")??"").match(/__Host-gsp_tiktok_state=([^;]+)/)?.[1];
  assert.ok(state);
  const callback=await get("/tiktok/callback?state="+encodeURIComponent(state)+"&error=access_denied",
    "GSGrimoire","__Host-gsp_tiktok_state="+state);
  assert.equal(callback.status,400,"the test uses a cancelled consent without TikTok token exchange");
  assert.match(await callback.text(),/TikTok authorization was cancelled/);
  assert.equal(await account(),null);
  assert.equal(await states(),beforeState,"OAuth state consumed, even on denied consent");
  const replay=await get("/tiktok/callback?state="+encodeURIComponent(state)+"&error=access_denied",
    "GSGrimoire","__Host-gsp_tiktok_state="+state);
  assert.equal(replay.status,400);
  assert.match(await replay.text(),/expired or was already used/);
});

test("shared five-failure approval PIN lockout also blocks TikTok settings before any mutation",async()=>{
  await resetFailures();
  const beforeState=await states();
  for(let i=0;i<5;i++){
    const response=await submit("connect","000000");
    assert.equal(response.status,403,await response.clone().text());
  }
  assert.equal(await pinLocked(db),true);
  for(const action of ["connect","disconnect","verify"] as const){
    const response=await submit(action,PIN);
    assert.equal(response.status,429,action+": "+await response.clone().text());
  }
  assert.equal(await states(),beforeState);
  assert.equal(await verification(),"verification-string-for-tests",
    "lockout cannot alter a previous verification file");
  await resetFailures();
  assert.equal(await pinLocked(db),false);
});
