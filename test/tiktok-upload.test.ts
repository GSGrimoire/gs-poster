import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createPost,attachDraftVideo,getPost} from "../src/db.ts";
import {parseNewDraft,blankNewDraft} from "../src/new-draft.ts";
import {beginTikTokConnection,finishTikTokConnection,sealTikTokTokens,unsealTikTokTokens,
  tiktokConnection,tiktokAccessToken,TIKTOK_SCOPES,tiktokRedirect} from "../src/tiktok.ts";
import {allowedTikTokUploadUrl,startTikTokInboxTransfer,getTikTokInboxTransfer,
  refreshTikTokInboxTransfer} from "../src/tiktok-inbox.ts";
import type {Env} from "../src/env.ts";
import type {Session} from "../src/session.ts";

let worker:Miniflare;
let env:Env;
const session={login:"GSGrimoire",raw:"signed-test-session"} as Session;
const token={access_token:"first-secret-access",refresh_token:"first-secret-refresh",
  open_id:"tt-account-1",scope:"user.info.basic,video.upload",
  expires_in:3600,refresh_expires_in:2000000,token_type:"Bearer"};
before(async()=>{
  worker=new Miniflare(convertV4MiniflareOptions({
    modules:true,cf:false,script:"export default {fetch(){return new Response('test')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]
  }));
  const db=await worker.getD1Database("DB") as unknown as D1Database;
  env={
    DB:db,TIKTOK_CLIENT_KEY:"test-key",TIKTOK_CLIENT_SECRET:"never-log-this-secret",
    TIKTOK_TOKEN_ENCRYPTION_KEY:"secure-test-only-secret-dedicated-to-tiktok-987654321",
    TIMEZONE:"Europe/Copenhagen"
  } as Env;
});
after(async()=>await worker.dispose());

test("TikTok Login Kit optionally requests both video.upload and video.publish",()=>{
  assert.deepEqual([...TIKTOK_SCOPES],["user.info.basic","video.upload","video.publish"]);
  assert.equal(tiktokRedirect(env),"https://gs-poster.goofyspook.workers.dev/tiktok/callback");
});
test("token ciphertext is authenticated, not readable, and tampering fails",async()=>{
  const sealed=await sealTikTokTokens(env,token);
  assert.ok(sealed.startsWith("v1."));
  assert.ok(!sealed.includes("first-secret-access"));
  assert.deepEqual(await unsealTikTokTokens(env,sealed),token);
  await assert.rejects(unsealTikTokTokens(env,sealed.slice(0,-4)+"aaaa"));
});

test("TikTok connection validates session-bound single-use state and stores encrypted tokens",async()=>{
  const previous=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async (input,init)=>{
    calls++;
    assert.equal(String(input),"https://open.tiktokapis.com/v2/oauth/token/");
    assert.equal(init?.method,"POST");
    assert.equal(init?.redirect,"manual");
    const form=init?.body as URLSearchParams;
    assert.equal(form.get("grant_type"),"authorization_code");
    assert.equal(form.get("code"),"fake-code");
    return Response.json(token);
  };
  try {
    const link=await beginTikTokConnection(env,session,["video.upload","video.publish"]);
    assert.equal(new URL(link.url).searchParams.get("scope"),"user.info.basic,video.upload,video.publish");
    const callbackUrl="https://gs-poster.goofyspook.workers.dev/tiktok/callback?state="+encodeURIComponent(link.state)+"&code=fake-code";
    const req=new Request(callbackUrl,{headers:{Cookie:"__Host-gsp_tiktok_state="+link.state}});
    const result=await finishTikTokConnection(env,session,req);
    assert.equal(result.open_id,"tt-account-1");
    assert.equal(calls,1);
    await assert.rejects(finishTikTokConnection(env,session,req),/already used|expired/);
    assert.equal((await tiktokConnection(env.DB))?.scopes,"user.info.basic,video.upload");
    assert.equal(await tiktokAccessToken(env,"video.upload"),"first-secret-access");
    await assert.rejects(tiktokAccessToken(env,"video.publish"),/not granted/);
  }finally{globalThis.fetch=previous;}
});

test("only TikTok-controlled HTTPS upload hosts are allowed",()=>{
  assert.equal(allowedTikTokUploadUrl("https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=test"),true);
  assert.equal(allowedTikTokUploadUrl("https://upload.us.tiktokapis.com/video/?upload_id=1"),true);
  assert.equal(allowedTikTokUploadUrl("https://open-upload.tiktokapis.com.evil.org/video/"),false);
  assert.equal(allowedTikTokUploadUrl("http://open-upload.tiktokapis.com/video/"),false);
  assert.equal(allowedTikTokUploadUrl("https://open-upload.tiktokapis.com@evil.org/video/"),false);
  assert.equal(allowedTikTokUploadUrl("https://open-upload.tiktokapis.com/other"),false);
});

test("inbox upload is single-chunk private transfer with audit-safe idempotence",async()=>{
  const ref="upload://"+"a".repeat(32)+".mp4";
  const fakeBytes=new Uint8Array(6*1024*1024);
  fakeBytes.set([0,0,0,24,102,116,121,112,105,115,111,109],0);
  env.UPLOADS={
    get:async(key:string)=>{
      assert.equal(key,"uploads/"+"a".repeat(32)+".mp4");
      return {arrayBuffer:async()=>fakeBytes.buffer};
    }
  } as unknown as R2Bucket;
  const p=await createPost(env.DB,{
    message:"Video post",images:[],video:ref,scheduled_at:null,
    created_by:"test",facebook_enabled:true,bluesky:null,
  });
  const previous=globalThis.fetch;
  let initCount=0,putCount=0;
  globalThis.fetch=async(input,options)=>{
    const url=String(input);
    if(url.endsWith("/inbox/video/init/")){
      initCount++;
      assert.equal(options?.method,"POST");
      assert.ok(!JSON.stringify(options?.body).includes("video.publish"));
      const source=JSON.parse(String(options?.body)).source_info;
      assert.equal(source.source,"FILE_UPLOAD");
      assert.equal(source.video_size,fakeBytes.length);
      assert.equal(source.chunk_size,fakeBytes.length);
      assert.equal(source.total_chunk_count,1);
      return Response.json({data:{publish_id:"v_inbox_file~v2.123",
        upload_url:"https://open-upload.tiktokapis.com/video/?upload_id=123&upload_token=secret"},
        error:{code:"ok"}});
    }
    if(url.startsWith("https://open-upload.tiktokapis.com/video/")){
      putCount++;
      assert.equal(options?.method,"PUT");
      const headers=options?.headers as Record<string,string>;
      assert.equal(headers["Content-Range"],"bytes 0-"+(fakeBytes.length-1)+"/"+fakeBytes.length);
      assert.equal(headers["Content-Length"],String(fakeBytes.length));
      return new Response(null,{status:201});
    }
    if(url.endsWith("/status/fetch/"))
      return Response.json({data:{status:"SEND_TO_USER_INBOX"},error:{code:"ok"}});
    throw new Error("Unexpected network call: "+url);
  };
  try {
    const result=await startTikTokInboxTransfer(env,p.id,p.updated_at,"GSGrimoire");
    assert.equal(result.status,"transfer_complete");
    assert.equal(initCount,1);assert.equal(putCount,1);
    await assert.rejects(startTikTokInboxTransfer(env,p.id,p.updated_at,"GSGrimoire"),/already exists/);
    assert.equal(initCount,1);assert.equal(putCount,1);
    const checked=await refreshTikTokInboxTransfer(env,p.id,"GSGrimoire");
    assert.equal(checked.status,"inbox_ready");
    assert.equal(checked.publish_id,"v_inbox_file~v2.123");
    assert.equal((await getTikTokInboxTransfer(env.DB,p.id))?.status,"inbox_ready");
  }finally{globalThis.fetch=previous;}
});

test("TikTok-only video drafts remain unapproved and cannot trigger Facebook posting",async()=>{
  const input=parseNewDraft({...blankNewDraft(),facebook:false,bluesky:false,
    tiktok:true,contentKind:"video",label:"TikTok-first"}, "Europe/Copenhagen","reviewer");
  assert.equal(input.facebook_enabled,false);
  assert.equal(input.bluesky,null);
  assert.equal(input.tiktok_enabled,true);
  const p=await createPost(env.DB,input);
  assert.equal(p.facebook_enabled,false);
  assert.equal(p.tiktok_enabled,true);
  assert.equal(p.approved_at,null);
  const ref="upload://"+"e".repeat(32)+".mp4";
  const revision=await attachDraftVideo(env.DB,p.id,ref,"",false,false,p.updated_at,true);
  assert.ok(revision);
  const after=(await getPost(env.DB,p.id))!;
  assert.equal(after.video,ref);
  assert.equal(after.status,"draft");
  assert.equal(after.approved_at,null);
  assert.equal(after.facebook_enabled,false);
  const noTikTok=await createPost(env.DB,{
    message:"Other video",images:[],video:null,created_by:"reviewer",
    scheduled_at:null,facebook_enabled:false,bluesky:{caption:"Test",images:[],video:null,patreon:null},
  });
  assert.equal(await attachDraftVideo(env.DB,noTikTok.id,ref,"",false,false,noTikTok.updated_at,true),null);
});
test("TikTok supports images and video, not text-only drafts",()=>{
  assert.throws(()=>parseNewDraft({...blankNewDraft(),facebook:false,bluesky:false,
    tiktok:true,contentKind:"text"},"Europe/Copenhagen","reviewer"),/select Images or Video/i);
  assert.equal(parseNewDraft({...blankNewDraft(),facebook:false,bluesky:false,
    tiktok:true,contentKind:"images"},"Europe/Copenhagen","reviewer").tiktok_enabled,true);
});

test("TikTok OAuth does not follow token endpoint redirects",async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async (_input,options)=>{
    assert.equal(options?.redirect,"manual");
    return new Response(null,{status:302,headers:{Location:"https://untrusted.example/token"}});
  };
  try {
    await assert.rejects(tiktokAccessToken(env,"video.publish"),/not granted/);
  }finally{globalThis.fetch=old;}
});
