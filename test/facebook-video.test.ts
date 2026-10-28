import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageVideo, getPageVideoInfo, rescheduleFbPost, editFbCaption } from "../src/facebook.ts";
import type { Env } from "../src/env.ts";

const env={FB_PAGE_ID:"page",FB_PAGE_TOKEN:"test-token",GRAPH_BASE_URL:"http://127.0.0.1:8999"} as Env;
const bytes=new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);

test("approved Page video uses multipart source instead of public URL, and is scheduled",async()=>{
  const old=globalThis.fetch;
  let payload:FormData | null=null;
  globalThis.fetch=async (input,init)=>{
    assert.equal(String(input).split("?")[0],"http://127.0.0.1:8999/page/videos");
    assert.equal(init?.method,"POST");
    payload=init?.body as FormData;
    return Response.json({id:"video_123"});
  };
  try{
    const id=await createPageVideo(env,{bytes,title:"GS Video",description:"House rules",scheduledUnix:1980000000});
    assert.equal(id,"video_123");
    assert.equal(payload?.get("published"),"false");
    assert.equal(payload?.get("scheduled_publish_time"),"1980000000");
    assert.equal(payload?.get("title"),"GS Video");
    assert.equal(payload?.get("description"),"House rules");
    assert.equal(payload?.get("access_token"),"test-token");
    assert.equal(payload?.has("file_url"),false);
    assert.equal((payload?.get("source") as File).size,bytes.length);
  }finally{globalThis.fetch=old;}
});

test("video metadata maps Graph's published field into GS Poster state",async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async(input)=>{
    assert.match(String(input),/video_123/);
    return Response.json({published:false,description:"House rules",scheduled_publish_time:1980000000});
  };
  try{
    const info=await getPageVideoInfo(env,"video_123");
    assert.equal(info?.is_published,false);
    assert.equal(info?.message,"House rules");
  }finally{globalThis.fetch=old;}
});

test("scheduled video changes use description and video fields, never feed-post message",async()=>{
  const old=globalThis.fetch;
  let time=1980000000,description="Original";
  globalThis.fetch=async(input,init)=>{
    if(init?.method==="POST"){
      const body=init.body as URLSearchParams;
      if(body.has("scheduled_publish_time"))time=Number(body.get("scheduled_publish_time"));
      if(body.has("description"))description=String(body.get("description"));
      assert.equal(body.has("message"),false);
      return Response.json({success:true});
    }
    return Response.json({published:false,scheduled_publish_time:time,description});
  };
  try{
    await rescheduleFbPost(env,"video_123",1980000000,1980003600,true);
    await editFbCaption(env,"video_123",1980003600,"Original","Updated",true);
    assert.equal(time,1980003600);
    assert.equal(description,"Updated");
  }finally{globalThis.fetch=old;}
});
