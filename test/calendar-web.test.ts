import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPost, updatePost, getPost } from "../src/db.ts";
import { handleWeb } from "../src/web.ts";
import { makeSession, csrfToken, SESSION_COOKIE } from "../src/session.ts";
import type { Env } from "../src/env.ts";

let worker:Miniflare;
let db:D1Database;
const env={TIMEZONE:"Europe/Copenhagen",COOKIE_SECRET:"test-only-cookie",
  APPROVE_PIN:"123456",ALLOWED_GITHUB_LOGINS:"GSGrimoire"} as Env;
let cookie="";
let csrf="";
before(async()=>{
  worker=new Miniflare(convertV4MiniflareOptions({modules:true,cf:false,
    script:"export default {fetch(){return new Response('test')}}",
    compatibilityDate:"2026-09-01",d1Databases:["DB"]}));
  db=await worker.getD1Database("DB") as unknown as D1Database;
  env.DB=db;
  const raw=await makeSession(env,"GSGrimoire");
  cookie=SESSION_COOKIE+"="+raw;
  csrf=await csrfToken(env,{login:"GSGrimoire",raw});
});
after(async()=>{await worker?.dispose();});
async function request(id:string,action:string,pin:string,version:string,when:string) {
  const body=new URLSearchParams({csrf,pin,expected_updated_at:version,when});
  return handleWeb(new Request("https://poster.example/post/"+id+"/"+action,{
    method:"POST",headers:{"Origin":"https://poster.example","Cookie":cookie,
      "Content-Type":"application/x-www-form-urlencoded"},body
  }),env);
}
test("calendar web reschedule rejects wrong PIN before mutating a draft",async()=>{
  const time=new Date(Date.now()+4*60*60_000).toISOString();
  const p=await createPost(db,{message:"Draft",images:[],created_by:"test",scheduled_at:time});
  const out=await request(p.id,"reschedule","bad",p.updated_at,"2030-11-01T16:00");
  assert.equal(out.status,403);
  assert.equal((await getPost(db,p.id))?.scheduled_at,time);
});
test("calendar web reschedule rejects stale optimistic version",async()=>{
  const time=new Date(Date.now()+4*60*60_000).toISOString();
  const p=await createPost(db,{message:"Draft",images:[],created_by:"test",scheduled_at:time});
  const out=await request(p.id,"reschedule","123456","stale-version","2030-11-01T16:00");
  assert.equal(out.status,409);
  assert.equal((await getPost(db,p.id))?.scheduled_at,time);
});
test("calendar web handler refuses editing a released post",async()=>{
  const time=new Date(Date.now()-24*60*60_000).toISOString();
  const p=await createPost(db,{message:"Published",images:[],created_by:"test",scheduled_at:time});
  await updatePost(db,p.id,{status:"published",approved_at:time});
  const v=(await getPost(db,p.id))!;
  const out=await request(p.id,"reschedule","123456",v.updated_at,"2030-11-01T16:00");
  assert.equal(out.status,409);
  assert.equal((await getPost(db,p.id))?.scheduled_at,time);
});
