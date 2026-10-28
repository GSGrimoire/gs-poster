import { test } from "node:test";
import assert from "node:assert/strict";
import { editFbCaption, rescheduleFbPost, normalizeCaption } from "../src/facebook.ts";
import type { Env } from "../src/env.ts";

const env = {FB_PAGE_ID:"page",FB_PAGE_TOKEN:"fake-for-test",
  GRAPH_BASE_URL:"http://127.0.0.1:8999"} as Env;

test("Facebook reschedule updates the existing post and verifies remote time", async () => {
  const originalFetch = globalThis.fetch;
  let time = 1980000000;
  let caption = "Original caption";
  let writes = 0;
  let released = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.match(url,/127\.0\.0\.1:8999\/page_post/);
    if (init?.method === "POST") {
      writes++;
      const body = init.body as URLSearchParams;
      if (body.has("scheduled_publish_time")) time = Number(body.get("scheduled_publish_time"));
      if (body.has("message")) caption = String(body.get("message"));
      return Response.json({success:true});
    }
    return Response.json({is_published:released,scheduled_publish_time:time,message:caption});
  };
  try {
    await rescheduleFbPost(env,"page_post",1980000000,1980003600);
    assert.equal(time,1980003600);
    assert.equal(writes,1);
    await editFbCaption(env,"page_post",1980003600,"Original caption","Edited caption");
    assert.equal(caption,"Edited caption");
    assert.equal(writes,2);
    released=true;
    await assert.rejects(rescheduleFbPost(env,"page_post",1980003600,1980007200),/no longer confirms/);
    await assert.rejects(editFbCaption(env,"page_post",1980003600,"Edited caption","Never"),/changed or was released/);
    assert.equal(writes,2,"editing already released content must not send a write");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Facebook refuses a schedule that does not match the locally saved version", async () => {
  const originalFetch=globalThis.fetch;
  let writes=0;
  globalThis.fetch=async (_input,init)=>{
    if(init?.method==="POST") writes++;
    return Response.json({is_published:false,scheduled_publish_time:1980003600,message:"Original"});
  };
  try{
    await assert.rejects(rescheduleFbPost(env,"page_post",1980000000,1980010000),/differs/);
    assert.equal(writes,0);
  }finally{globalThis.fetch=originalFetch;}
});

test("Facebook caption normalization accepts browser CRLF and Meta line breaks", async () => {
  assert.equal(normalizeCaption("first\r\nsecond   \r\n"),"first\nsecond");
  const originalFetch=globalThis.fetch;
  let message="first\nsecond";
  let writes=0;
  globalThis.fetch=async (_input,init)=>{
    if (init?.method==="POST") {
      writes++;
      message=String((init.body as URLSearchParams).get("message")||"").replace(/\r\n/g,"\n").trimEnd();
    }
    return Response.json({is_published:false,scheduled_publish_time:1980000000,message});
  };
  try {
    await editFbCaption(env,"page_post",1980000000,"first\r\nsecond  \n","first\r\nchanged  \r\n");
    assert.equal(message,"first\nchanged");
    assert.equal(writes,1);
  } finally {globalThis.fetch=originalFetch;}
});
