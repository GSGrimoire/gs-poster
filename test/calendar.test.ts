import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { weekStart, weekRange, dayPlus, postCalendarTime, renderCalendar } from "../src/calendar.ts";
import { createPost, getPost, listCalendarPosts, updateCalendarTime, updateCalendarCaptions, updatePost, claimForPublish } from "../src/db.ts";
import type { Post } from "../src/db.ts";
import type { Env } from "../src/env.ts";

const zone = "Europe/Copenhagen";

test("Sunday calendar navigation stays stable across October daylight saving change", () => {
  assert.equal(weekStart("2026-10-28"), "2026-10-25");
  assert.equal(dayPlus("2026-10-25", -7), "2026-10-18");
  assert.equal(dayPlus("2026-10-25", 7), "2026-11-01");
  assert.deepEqual(weekRange("2026-10-25",zone), {
    from: "2026-10-24T22:00:00.000Z",
    to: "2026-10-31T23:00:00.000Z",
  });
  assert.throws(() => weekStart("2026-02-30"),/Invalid/);
});

let worker: Miniflare;
let db: D1Database;
before(async () => {
  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, cf: false,
    script: "export default { fetch() { return new Response('calendar test'); } };",
    compatibilityDate: "2026-09-01", d1Databases: ["DB"],
  }));
  db = await worker.getD1Database("DB") as unknown as D1Database;
});
after(async () => { await worker?.dispose(); });

test("calendar includes week-specific scheduled posts and retains published history", async () => {
  const p = await createPost(db, { message:"Archive post", images:[], created_by:"ChatGPT",
    scheduled_at:"2026-10-28T18:00:00.000Z" });
  await updatePost(db,p.id,{status:"published",approved_at:"2026-10-25T10:00:00.000Z"});
  const q = await createPost(db, { message:"Another week", images:[], created_by:"Claude",
    scheduled_at:"2026-11-11T18:00:00.000Z" });
  const range = weekRange("2026-10-25",zone);
  const posts = await listCalendarPosts(db,range.from,range.to);
  assert.ok(posts.some(x=>x.id===p.id));
  assert.ok(!posts.some(x=>x.id===q.id));
  const saved = (await getPost(db,p.id))!;
  assert.equal(postCalendarTime(saved),"2026-10-28T18:00:00.000Z");
  const markup = renderCalendar({TIMEZONE:zone} as Env,posts,"csrf-test","2026-10-25",new Date("2026-10-27T12:00:00Z"));
  assert.match(markup,/Archive post/);
  assert.match(markup,/ChatGPT/);
  assert.match(markup,/data-status="published"/);
  assert.match(markup,/draggable="false"/);
  assert.match(markup,/calendar-slot disabled/);
});

test("draft calendar moves are version-guarded and do not grant approval", async () => {
  const p = await createPost(db, {message:"Unapproved",images:[],created_by:"test",scheduled_at:"2030-10-28T18:00:00Z"});
  assert.equal(await updateCalendarTime(db,p.id,"2030-10-29T18:00:00Z",p.updated_at,false),true);
  assert.equal(await updateCalendarTime(db,p.id,"2030-10-30T18:00:00Z",p.updated_at,false),false);
  const moved=(await getPost(db,p.id))!;
  assert.equal(moved.scheduled_at,"2030-10-29T18:00:00Z");
  assert.equal(moved.approved_at,null);
  assert.equal(moved.status,"draft");
  const claimed=await claimForPublish(db,p.id,{
    message:moved.message,facebookEnabled:true,bluesky:null,
    scheduledAt:new Date("2030-10-29T18:00:00Z"),expectedUpdatedAt:moved.updated_at,
  });
  assert.equal(claimed,true);
  assert.equal(await updateCalendarTime(db,p.id,"2030-10-30T18:00:00Z",(await getPost(db,p.id))!.updated_at,false),false);
});

test("caption edits remain pending, preserve target selection and reject stale versions", async () => {
  const p = await createPost(db, { message:"Facebook original", images:[],
    scheduled_at:"2030-10-28T18:00:00Z", created_by:"ChatGPT",
    bluesky:{caption:"Bluesky original",images:[],patreon:null} });
  assert.equal(await updateCalendarCaptions(db,p,"Facebook revised","Bluesky revised",false),true);
  assert.equal(await updateCalendarCaptions(db,p,"stale","stale",false),false);
  const revised=(await getPost(db,p.id))!;
  assert.equal(revised.message,"Facebook revised");
  assert.equal(revised.bluesky?.caption,"Bluesky revised");
  assert.equal(revised.bluesky?.status,"draft");
  assert.equal(revised.status,"draft");
  assert.equal(revised.approved_at,null);
  await claimForPublish(db,p.id,{
    message:revised.message,facebookEnabled:true,
    bluesky:{caption:revised.bluesky!.caption,images:[],patreon:null},
    scheduledAt:new Date("2030-10-28T18:00:00Z"),expectedUpdatedAt:revised.updated_at,
  });
  const claimed=(await getPost(db,p.id))!;
  assert.equal(await updateCalendarCaptions(db,claimed,"Not allowed","Not allowed",false),false);
});
