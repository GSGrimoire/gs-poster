import { test } from "node:test";
import assert from "node:assert/strict";
import { blankNewDraft, newDraftPrefill, newDraftTime, parseNewDraft, renderNewDraft, soonestDraftTime } from "../src/new-draft.ts";
import { renderCalendar, CALENDAR_JS } from "../src/calendar.ts";
import { NEW_DRAFT_JS } from "../src/new-draft-client.ts";
import type { Env } from "../src/env.ts";

const zone="Europe/Copenhagen";
const now=new Date("2026-10-28T12:20:00Z");
const slot="2026-10-28T16:30";

test("calendar available slots open a new draft with the chosen local time",()=>{
  const html=renderCalendar({TIMEZONE:zone} as Env,[],"csrf-test","2026-10-25",now);
  assert.match(html,/data-when="2026-10-28T16:30"[^>]*role="button"/);
  assert.match(html,/title="Create draft for 2026-10-28 16:30"/);
  assert.match(html,/data-when="2026-10-28T12:00"[^>]*aria-disabled="true"/);
  assert.match(CALENDAR_JS,/window\.location\.assign\("\/new\?when=" \+ encodeURIComponent\(slot\.dataset\.when\)\)/);
  assert.match(CALENDAR_JS,/Date\.now\(\) < ignoreSlotClicksUntil/);
  assert.match(CALENDAR_JS,/if \(moving \|\|/);
});

test("calendar prefill preserves Copenhagen wall time, rejects invalid and unavailable slots",()=>{
  assert.equal(newDraftPrefill(slot,zone,now),slot);
  assert.equal(newDraftTime(slot,zone,now)?.toISOString(),"2026-10-28T15:30:00.000Z");
  assert.equal(newDraftPrefill("2026-10-28T13:20",zone,now),"");
  assert.equal(newDraftPrefill("2026-03-29T02:30",zone,new Date("2026-03-01T10:00:00Z")),"");
  assert.equal(newDraftPrefill("2026-02-30T10:00",zone,new Date("2026-02-01T10:00:00Z")),"");
  assert.equal(newDraftPrefill("javascript:alert(1)",zone,now),"");
  assert.equal(newDraftPrefill("2026-12-28T15:00",zone,now),"");
});

test("new form creates a pending, unapproved post with optional video placeholder",()=>{
  const fields={...blankNewDraft(slot),label:"House Rules video",release:"Compendium"};
  const input=parseNewDraft(fields,zone,"Reviewer",now);
  assert.equal(input.scheduled_at,"2026-10-28T15:30:00.000Z");
  assert.equal(input.facebook_enabled,true);
  assert.equal(input.message,"");
  assert.deepEqual(input.images,[]);
  assert.equal(input.video,null);
  assert.equal(input.bluesky?.caption,"");
  assert.equal(input.created_by,"GS Poster web (via Reviewer)");
});

test("new draft form escapes content and never includes approval or PIN controls",()=>{
  const html=renderNewDraft({...blankNewDraft(slot),label:'<img src=x onerror="alert(1)">',message:"<hello>"},'csrf<&"',zone,"Example <error>");
  assert.match(html,/New post draft/);
  assert.match(html,/name="csrf"/);
  assert.match(html,/value="2026-10-28T16:30"/);
  assert.match(html,/&#60;img src=x/);
  assert.match(html,/&#60;hello&#62;/);
  assert.match(html,/Example &#60;error&#62;/);
  assert.doesNotMatch(html,/name="pin"|\/approve|\/publish/);
});

test("invalid target, caption, stale times and oversized text cannot be saved",()=>{
  assert.throws(()=>parseNewDraft({...blankNewDraft(),facebook:false,bluesky:false},zone,"reviewer",now),/Select Facebook/);
  assert.throws(()=>parseNewDraft({...blankNewDraft(),bsCaption:"Z".repeat(301)},zone,"reviewer",now),/300-character/);
  assert.throws(()=>parseNewDraft({...blankNewDraft(),when:"2026-10-28T13:30"},zone,"reviewer",now),/12 minutes/);
  assert.throws(()=>parseNewDraft({...blankNewDraft(),label:"X".repeat(121)},zone,"reviewer",now),/120 characters/);
});

test("earliest release button rounds 12-minute lead up to next whole minute",()=>{
  assert.equal(soonestDraftTime(zone,new Date("2026-10-28T10:01:01.000Z")),"2026-10-28T11:14");
  assert.equal(soonestDraftTime(zone,new Date("2026-10-28T10:01:00.000Z")),"2026-10-28T11:13");
  // The server calculates in Europe/Copenhagen rather than the browser locale.
  assert.equal(soonestDraftTime(zone,new Date("2026-12-01T10:01:01.000Z")),"2026-12-01T11:14");
  assert.equal(soonestDraftTime(zone,new Date("2026-03-29T00:54:01.000Z")),"2026-03-29T03:07");
  assert.ok(newDraftTime(soonestDraftTime(zone,new Date("2026-10-28T10:01:01Z")),zone,new Date("2026-10-28T10:01:01Z")));
});

test("branching composer exposes file fields and hides irrelevant platform fields",()=>{
  const image=renderNewDraft({...blankNewDraft(slot),contentKind:"images"}, "csrf", zone);
  assert.match(image,/input type="radio" name="content_kind" value="images" checked/);
  assert.match(image,/id="new-images-panel"/);
  assert.match(image,/id="new-video-panel" hidden/);
  assert.match(image,/id="new-images-input"[^>]*multiple/);
  const video=renderNewDraft({...blankNewDraft(slot),contentKind:"video"}, "csrf", zone);
  assert.match(video,/id="new-video-panel"/);
  assert.match(video,/id="new-images-panel" hidden/);
  assert.match(video,/id="new-video-preview"/);
  assert.match(video,/name="asap" id="new-asap"/);
  assert.match(video,/id="new-asap-button"/);
  assert.match(video,/src="\/new-draft\.js"/);
  assert.match(video,/data-zone="Europe\/Copenhagen"/);
});

test("client creates an unapproved draft before private media upload and recovers partial uploads",()=>{
  assert.match(NEW_DRAFT_JS,/fetch\("\/new"/);
  assert.match(NEW_DRAFT_JS,/headers:\{"Accept":"application\/json"\}/);
  assert.match(NEW_DRAFT_JS,/api\(mediaKind === "video" \? "video-link" : "upload-link"/);
  assert.match(NEW_DRAFT_JS,/api\(mediaKind === "video" \? "attach-video" : "attach-image"/);
  assert.match(NEW_DRAFT_JS,/created = \{id:body.id,version:body.updated_at\}/);
  assert.match(NEW_DRAFT_JS,/Your draft is saved/);
  assert.match(NEW_DRAFT_JS,/if \(asap.value === "1"\) time.value = soonestTime\(\)/);
  assert.match(NEW_DRAFT_JS,/form\.querySelectorAll\('input\[name="content_kind"\]/);
  assert.doesNotMatch(NEW_DRAFT_JS,/\/approve|\/publish/);
});

test("composer rejects unsupported content types and still creates unapproved records",()=>{
  assert.throws(()=>parseNewDraft({...blankNewDraft(),contentKind:"invalid" as any},zone,"reviewer",now),/supported content type/);
  const video=parseNewDraft({...blankNewDraft(),contentKind:"video"},zone,"reviewer",now);
  assert.equal(video.video,null);
  assert.equal(video.scheduled_at,null);
  assert.equal(video.facebook_enabled,true);
  assert.deepEqual(video.bluesky?.images,[]);
});
