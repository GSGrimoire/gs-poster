import {test} from "node:test";
import assert from "node:assert/strict";
import {renderMonthCalendar,MONTH_CALENDAR_JS} from "../src/calendar.ts";
import {calendarReturnAfterMove} from "../src/web.ts";
import type {Post} from "../src/db.ts";
import type {Env} from "../src/env.ts";

const zone="Europe/Copenhagen";
const env={TIMEZONE:zone} as Env;
const base={
  id:"p_draft",label:"Scheduled design",message:"Ready for planning",created_by:"test",
  created_at:"2030-11-01T09:00:00.000Z",updated_at:"2030-11-01T09:00:00.000Z",
  scheduled_at:"2030-11-09T18:30:00.000Z",approved_at:null,status:"draft",
  facebook_enabled:true,tiktok_enabled:false,images:[],tiktok_images:null,
  video:null,bluesky:null,instagram:null,
} as unknown as Post;

test("Month retains clickable day and post links while exposing PIN-gated move controls",()=>{
  const posts:Post[]=[
    base,
    {...base,id:"p_unplanned",label:"Unscheduled idea",scheduled_at:null},
    {...base,id:"p_published",label:"Published result",status:"published",approved_at:"2030-11-01T09:30:00.000Z"},
    {...base,id:"p_locked",label:"Publishing soon",status:"scheduled",approved_at:"2030-11-01T09:30:00.000Z",
      scheduled_at:"2030-11-09T12:04:00.000Z"},
    {...base,id:"p_future",label:"Scheduled target",status:"scheduled",approved_at:"2030-11-01T09:30:00.000Z"},
  ];
  const html=renderMonthCalendar(env,posts,"2030-11",new Date("2030-11-09T12:00:00.000Z"),
    {page:2,hasNext:true},"aSafeCsrfToken");
  assert.match(html,/id="month-cal-form"/);
  assert.match(html,/src="\/calendar-month\.js"/);
  assert.match(html,/name="csrf" value="aSafeCsrfToken"/);
  assert.match(html,/name="return_to" value="\/calendar\?view=month&amp;month=2030-11&amp;month_page=2"/);
  assert.match(html,/href="\/post\/p_draft"/);
  assert.match(html,/href="\/calendar\?view=week&amp;week=2030-11-09"/);
  assert.match(html,/Plan this day/);
  assert.match(html,/data-day="2030-11-09" tabindex="0"/);
  assert.match(html,/data-id="p_draft"[^>]*data-when="2030-11-09T19:30"/);
  assert.match(html,/data-id="p_unplanned"[^>]*data-unscheduled="1"/);
  assert.match(html,/data-id="p_future"[^>]*draggable|draggable="true" data-id="p_future"/);
  assert.ok(html.includes('aria-label="Move Scheduled design to another date"'));
  for(const id of ["p_published","p_locked"]){
    const card=html.match(new RegExp('<a class="calendar-month-post"[^>]*href="/post/'+id+'"[^>]*>'));
    assert.ok(card,"present "+id);
    assert.doesNotMatch(card[0],/draggable|data-version|data-when/,"immutable "+id);
  }
  assert.match(html,/type="password" name="pin"/);
  assert.match(html,/Confirm new time/);
  assert.doesNotMatch(html,/action="\/post\/p_draft\/approve"/);
});

test("Month drag script only opens a confirmation dialog and preserves time for date moves",()=>{
  assert.match(MONTH_CALENDAR_JS,/grid\.addEventListener\("dragstart"/);
  assert.match(MONTH_CALENDAR_JS,/grid\.addEventListener\("drop"/);
  assert.match(MONTH_CALENDAR_JS,/form\.elements\.namedItem\("when"\)\.value=day\+saved\.slice\(10\)/);
  assert.match(MONTH_CALENDAR_JS,/form\.elements\.namedItem\("pin"\)\.value=""/);
  assert.match(MONTH_CALENDAR_JS,/dialog\.showModal\(\)/);
  assert.match(MONTH_CALENDAR_JS,/month-cal-move|calendar-month-move/);
  assert.doesNotMatch(MONTH_CALENDAR_JS,/fetch\(|form\.submit\(|requestSubmit\(/);
});

test("calendar return navigation accepts only validated Week and Month planner paths",()=>{
  const id="p_draft";
  for(const dest of ["/calendar?view=month&month=2030-11",
    "/calendar?view=month&month=2030-11&month_page=2",
    "/calendar?view=week&week=2030-11-09",
    "/calendar?week=2030-11-09"])
    assert.equal(calendarReturnAfterMove(dest,id),dest);
  for(const rejected of ["/calendar?view=month&month=2030-13",
    "/calendar?view=month&month=2030-11&month_page=0",
    "/calendar?view=month&month=2030-11&next=https://evil.example",
    "//evil.example","/post/p_other","/calendar?view=week&week=2030-02-31",
    "/calendar?view=month&month=2030-11%0aSet-Cookie"])
    assert.equal(calendarReturnAfterMove(rejected,id),"/post/"+id);
});
