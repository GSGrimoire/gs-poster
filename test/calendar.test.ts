import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { weekStart, weekRange, monthStart, monthPlus, monthRange, dayPlus, postCalendarTime, renderCalendar, renderMonthCalendar, CALENDAR_JS, assignCalendarLanes } from "../src/calendar.ts";
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

test("overlapping calendar cards use separate lanes while later cards reuse space",()=>{
  const positions=assignCalendarLanes([540,550,610,700]);
  assert.deepEqual(positions.map(x=>x.lane),[0,1,0,0]);
  assert.deepEqual(positions.map(x=>x.lanes),[2,2,2,1]);
  assert.deepEqual(assignCalendarLanes([540,540,540]).map(x=>x.lane),[0,1,2]);
});

test("monthly date ranges include complete Sunday-Saturday weeks and cross daylight-saving boundaries",()=>{
  assert.equal(monthStart("2026-11"),"2026-11-01");
  assert.equal(monthPlus("2026-12",1),"2027-01");
  assert.equal(monthPlus("2027-01",-1),"2026-12");
  assert.deepEqual(monthRange("2026-11",zone),{
    from:"2026-10-31T23:00:00.000Z",
    to:"2026-12-05T23:00:00.000Z",
    startDay:"2026-11-01",endDay:"2026-12-06",
  });
  assert.deepEqual(monthRange("2026-03",zone),{
    from:"2026-02-28T23:00:00.000Z",
    to:"2026-04-04T22:00:00.000Z",
    startDay:"2026-03-01",endDay:"2026-04-05",
  });
  const may=monthRange("2026-05",zone);
  assert.equal(may.startDay,"2026-04-26");
  assert.equal(may.endDay,"2026-06-07","six complete calendar rows");
  for(const invalid of ["2026-00","2026-13","2026-1","foo","2026-11-09","9999-12","2026-11?next=1"]){
    assert.throws(()=>monthStart(invalid),/Invalid calendar month/);
  }
});

test("week planner has zone-aware live current time indicator and updates after midnight",()=>{
  const html=renderCalendar({TIMEZONE:zone} as Env,[],"csrf","2026-11-08",new Date("2026-11-09T13:05:00Z"));
  assert.match(html,/class="calendar-day" data-day="2026-11-09"/);
  assert.match(html,/class="calendar-now" hidden/);
  assert.match(html,/data-zone="Europe\/Copenhagen"/);
  assert.match(html,/aria-current="page">Week/);
  assert.match(html,/view=month&month=2026-11/);
  assert.match(CALENDAR_JS,/clock\.formatToParts\(new Date\(\)\)/);
  assert.match(CALENDAR_JS,/setInterval\(updateNowLine, 60000\)/);
  assert.match(CALENDAR_JS,/column\.dataset\.day !== today/);
  assert.match(CALENDAR_JS,/line\.style\.top = minute \+ "px"/);
});

test("month planner shows all day posts with thumbnails, statuses, and no hourly cards",()=>{
  const template={
    id:"p_testone",label:"",release:null,message:"Library art",created_by:"test",
    created_at:"2026-11-09T10:00:00.000Z",updated_at:"2026-11-09T10:00:00.000Z",
    scheduled_at:"2026-11-09T18:00:00.000Z",approved_at:null,status:"draft",
    facebook_enabled:true,tiktok_enabled:false,images:["https://raw.githubusercontent.com/example/repo/main/a.png"],
    tiktok_images:null,video:null,
    bluesky:null,instagram:null,
  } as unknown as Post;
  const items:Post[]=[
    {...template,id:"p_one",label:"First gallery"},
    {...template,id:"p_two",label:"Second gallery",status:"scheduled"},
    {...template,id:"p_three",label:"Third gallery",status:"published"},
    {...template,id:"p_tiktok",facebook_enabled:false,tiktok_enabled:true,tiktok_images:["https://raw.githubusercontent.com/example/repo/main/t.png"],label:"TikTok gallery"},
    {...template,id:"p_sky",facebook_enabled:false,tiktok_enabled:false,images:[],label:"Bluesky gallery",
      bluesky:{caption:"Blue",images:[{url:"https://raw.githubusercontent.com/example/repo/main/b.png",alt:"Blue"}],video:null,patreon:null}},
    {...template,id:"p_draft",facebook_enabled:false,images:[],scheduled_at:null,label:"Unscheduled idea"},
    {...template,id:"p_outside",scheduled_at:"2026-12-02T18:00:00.000Z",label:"Following month"},
  ];
  const html=renderMonthCalendar({TIMEZONE:zone} as Env,items,"2026-11",new Date("2026-11-09T12:00:00Z"));
  assert.match(html,/November 2026/);
  assert.match(html,/calendar-month-grid/);
  assert.match(html,/calendar-month-day today" data-day="2026-11-09"/);
  assert.match(html,/data-day="2026-12-02"/);
  for(const id of ["p_one","p_two","p_three","p_tiktok","p_sky","p_draft","p_outside"])
    assert.match(html,new RegExp('href="/post/'+id+'"'));
  assert.match(html,/src="\/media\/p_one\/0\?thumb=1&amp;platform=facebook"/);
  assert.match(html,/src="\/media\/p_tiktok\/0\?thumb=1&amp;platform=tiktok"/);
  assert.match(html,/src="\/media\/p_sky\/0\?thumb=1&amp;platform=bluesky"/);
  assert.match(html,/Unscheduled/);
  assert.match(html,/data-status="published"/);
  assert.match(html,/view=week&amp;week=2026-11-09/);
  assert.match(html,/aria-current="page">Month/);
  assert.doesNotMatch(html,/class="calendar-hour"/);
  assert.doesNotMatch(html,/class="cal-time"/);
  assert.doesNotMatch(html,/draggable="true"/);
  assert.doesNotMatch(html,/id="cal-form"/);
});

test("month labels and titles remain HTML-escaped",()=>{
  const example={
    id:"p_safe",label:"<img src=x onerror=alert(1)>",message:"Unsafe",release:null,
    scheduled_at:"2026-11-09T12:00:00Z",created_at:"2026-11-09T12:00:00Z",
    status:"draft",facebook_enabled:false,tiktok_enabled:false,images:[],bluesky:null,instagram:null,
  } as unknown as Post;
  const html=renderMonthCalendar({TIMEZONE:zone} as Env,[example],"2026-11");
  assert.doesNotMatch(html,/<img src=x onerror=alert\(1\)>/);
  assert.match(html,/&#60;img src=x/);
});

test("monthly calendar query does not discard posts after the weekly 500-item cap",async()=>{
  // A single bulk insertion isolates read behavior from upload and publish paths.
  await db.prepare(`WITH RECURSIVE seq(n) AS
    (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 810)
    INSERT INTO posts (id,created_at,updated_at,status,message,scheduled_at,created_by)
    SELECT 'p_monthbulk_'||n, '2031-04-02T10:00:00.000Z',
      '2031-04-02T10:00:00.000Z','draft','Bulk month post',
      '2031-04-15T12:00:00.000Z','test' FROM seq`).run();
  const range=monthRange("2031-04",zone);
  const limited=await listCalendarPosts(db,range.from,range.to);
  const first=await listCalendarPosts(db,range.from,range.to,true);
  const next=await listCalendarPosts(db,range.from,range.to,true,750);
  assert.equal(limited.length,500,"existing week remains bounded");
  assert.equal(first.length,751,"first month page includes one overflow sentinel");
  assert.equal(next.length,60,"remaining posts are reachable without an unbounded query");
  assert.equal(new Set([...first.slice(0,750),...next].map(x=>x.id)).size,810);
  const html=renderMonthCalendar({TIMEZONE:zone} as Env,first.slice(0,750),"2031-04",
    new Date("2031-04-15T12:00:00Z"),{page:1,hasNext:true});
  assert.match(html,/Month posts page 1/);
  assert.match(html,/month_page=2/);
  assert.match(html,/some days may continue on another page/);
});
