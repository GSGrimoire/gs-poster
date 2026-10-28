import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {csrfToken,type Session} from "../src/session.ts";
import {tiktokSettingsAction,TIKTOK_CONNECT_JS} from "../src/tiktok-web.ts";
import type {Env} from "../src/env.ts";
import {SECURITY_HEADERS} from "../src/html.ts";

let worker:Miniflare;
let env:Env;
const session={login:"GSGrimoire",raw:"signed-gs-poster-session"} as Session;
before(async()=>{
  worker=new Miniflare(convertV4MiniflareOptions({
    modules:true,cf:false,
    script:"export default {fetch(){return new Response('ok')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]
  }));
  env={
    DB:await worker.getD1Database("DB") as unknown as D1Database,
    COOKIE_SECRET:"test-signed-session-secret",
    TIKTOK_CLIENT_KEY:"sandbox-client-key",
    TIKTOK_CLIENT_SECRET:"sandbox-client-secret-must-not-leak",
    TIKTOK_TOKEN_ENCRYPTION_KEY:"this-is-a-random-test-key-with-more-than-32-chars"
  } as Env;
});
after(async()=>await worker?.dispose());

test("TikTok connect renders same-site navigation instead of a CSP-blocked form redirect",async()=>{
  const params=new URLSearchParams({
    csrf:await csrfToken(env,session),
    "video.upload":"1"
  });
  const req=new Request("https://gs-poster.goofyspook.workers.dev/tiktok/connect",{
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded",
      Origin:"https://gs-poster.goofyspook.workers.dev",
      "Sec-Fetch-Site":"same-origin",
    },
    body:params.toString(),
  });
  const response=await tiktokSettingsAction(req,env,session,"connect");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Location"),null);
  const cookie=response.headers.get("Set-Cookie")||"";
  assert.match(cookie,/__Host-gsp_tiktok_state=/);
  assert.match(cookie,/Secure;/);
  assert.match(cookie,/SameSite=Lax/);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.equal(response.headers.get("Referrer-Policy"),"no-referrer");
  assert.match(response.headers.get("Content-Security-Policy")||"",/form-action 'self'/);
  const body=await response.text();
  assert.match(body,/id="tiktok-continue-link"/);
  assert.match(body,/href="https:\/\/www\.tiktok\.com\/v2\/auth\/authorize\//);
  assert.match(body,/src="\/tiktok-connect\.js"/);
  assert.match(body,/client_key=sandbox-client-key/);
  assert.match(body,/scope=user\.info\.basic%2Cvideo\.upload/);
  assert.doesNotMatch(body,/sandbox-client-secret-must-not-leak/);
  assert.doesNotMatch(body,/TIKTOK_TOKEN_ENCRYPTION_KEY/);
});

test("top-level TikTok redirect script avoids form submission, preserves a manual fallback",()=>{
  assert.match(TIKTOK_CONNECT_JS,/window\.location\.replace\(target\.href\)/);
  assert.match(TIKTOK_CONNECT_JS,/target\.hostname !== "www\.tiktok\.com"/);
  assert.doesNotMatch(TIKTOK_CONNECT_JS,/submit\(|fetch\(|window\.open\(/);
  assert.match(SECURITY_HEADERS["Content-Security-Policy"],/form-action 'self'/);
});
